import { redirect } from "next/navigation";

export default function LegacyPaperLoginPage() {
  redirect("/auth/login");
}
