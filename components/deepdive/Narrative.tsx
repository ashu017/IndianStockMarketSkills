import type { AnalysisRow } from "@/lib/types";

export default function Narrative({
  analysis,
}: {
  analysis: AnalysisRow | null;
}) {
  if (!analysis || !analysis.narrative) {
    return <p className="text-sm text-zinc-500">No analysis yet.</p>;
  }

  const captionParts: string[] = [];
  if (analysis.generated_at) captionParts.push(`as of ${analysis.generated_at}`);
  if (analysis.model_version) captionParts.push(analysis.model_version);

  return (
    <div className="space-y-2">
      <p className="whitespace-pre-line text-sm leading-6 text-zinc-700">
        {analysis.narrative}
      </p>
      {captionParts.length > 0 && (
        <p className="text-xs text-zinc-400">{captionParts.join(" · ")}</p>
      )}
    </div>
  );
}
