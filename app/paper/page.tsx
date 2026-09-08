export const dynamic = "force-dynamic";

import TopNav from "@/components/portfolio/TopNav";
import PaperClient from "@/components/portfolio/PaperClient";

export default function PaperPage() {
  return (
    <>
      <TopNav currentPage="paper" />
      <PaperClient />
    </>
  );
}

