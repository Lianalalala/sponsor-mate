import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isLocalToolEnabled } from "@/lib/dev-only";

import WashingWorkbench from "./workbench";

export const metadata: Metadata = {
  title: "舊資料清洗",
  robots: { index: false },
};

export default function WashingPage() {
  if (!isLocalToolEnabled()) notFound();
  return <WashingWorkbench />;
}
