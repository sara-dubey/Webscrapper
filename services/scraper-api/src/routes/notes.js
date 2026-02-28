import express from "express";
import { z } from "zod";

import { prisma } from "../db/prisma.js";
import { requireAuth } from "../auth/middleware.js";

const router = express.Router();

const UpsertPaperNoteReq = z.object({
  paperId: z.string().min(1),
  note: z.string().optional(),
});

function clean(value) {
  const s = String(value || "").trim();
  return s || "";
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.userId;
    const paperId = clean(req.query.paperId);

    if (!paperId) {
      return res.status(400).json({ ok: false, error: "paperId is required" });
    }

    const item = await prisma.userPaperNote.findFirst({
      where: { userId, paperId },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ ok: true, item: item || null });
  } catch (err) {
    return next(err);
  }
});

router.put("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = UpsertPaperNoteReq.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.message });
    }

    const userId = req.user?.id || req.userId;
    const paperId = clean(parsed.data.paperId);
    const note = clean(parsed.data.note);

    const paper = await prisma.paperRecord.findUnique({
      where: { id: paperId },
      select: { id: true },
    });

    if (!paper) {
      return res.status(404).json({ ok: false, error: "Paper not found" });
    }

    if (!note) {
      await prisma.userPaperNote.deleteMany({
        where: { userId, paperId },
      });
      return res.json({ ok: true, item: null });
    }

    const item = await prisma.$transaction(async (tx) => {
      const existing = await tx.paperNote.findFirst({
        where: { userId, paperId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      if (existing?.id) {
        return await tx.paperNote.update({
          where: { id: existing.id },
          data: { note },
        });
      }

      return await tx.paperNote.create({
        data: {
          userId,
          paperId,
          note,
        },
      });
    });

    return res.json({ ok: true, item });
  } catch (err) {
    return next(err);
  }
});

export default router;
