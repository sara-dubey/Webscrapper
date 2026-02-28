import express from "express";
import { z } from "zod";

import { prisma } from "../db/prisma.js";
import { requireAuth } from "../auth/middleware.js";

const router = express.Router();

const CreateHighlightReq = z.object({
  paperId: z.string().optional(),
  source: z.string().optional(),
  externalId: z.string().optional(),
  pdfUrl: z.string().url().optional(),
  quote: z.string().min(1),
  note: z.string().optional(),
  color: z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .optional(),
});

function clean(value) {
  const s = String(value || "").trim();
  return s || null;
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.userId;
    const paperId = clean(req.query.paperId);
    const source = clean(req.query.source);
    const externalId = clean(req.query.externalId);

    const where = { userId };
    if (paperId) {
      where.paperId = paperId;
    } else if (source && externalId) {
      where.source = source;
      where.externalId = externalId;
    } else {
      return res.status(400).json({
        ok: false,
        error: "Provide paperId, or both source and externalId.",
      });
    }

    const items = await prisma.userPaperHighlight.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return res.json({ ok: true, items });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = CreateHighlightReq.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.message });
    }

    const userId = req.user?.id || req.userId;
    const paperIdRaw = clean(parsed.data.paperId);
    const source = clean(parsed.data.source);
    const externalId = clean(parsed.data.externalId);
    const pdfUrl = clean(parsed.data.pdfUrl);
    const quote = String(parsed.data.quote || "").trim();
    const note = clean(parsed.data.note);
    const color = clean(parsed.data.color) || "#ffe066";

    let paperId = paperIdRaw;
    if (!paperId && source && externalId) {
      const paper = await prisma.paperRecord.findUnique({
        where: { source_externalId: { source, externalId } },
        select: { id: true },
      });
      paperId = paper?.id || null;
    }

    if (!paperId && !(source && externalId)) {
      return res.status(400).json({
        ok: false,
        error: "Need paperId or (source + externalId) to attach this highlight.",
      });
    }

    const item = await prisma.userPaperHighlight.create({
      data: {
        userId,
        paperId,
        source,
        externalId,
        pdfUrl,
        quote,
        note,
        color,
      },
    });

    return res.json({ ok: true, item });
  } catch (err) {
    return next(err);
  }
});

router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.userId;
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const owned = await prisma.userPaperHighlight.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!owned) return res.status(404).json({ ok: false, error: "Highlight not found" });

    await prisma.userPaperHighlight.delete({ where: { id } });
    return res.json({ ok: true, id });
  } catch (err) {
    return next(err);
  }
});

export default router;
