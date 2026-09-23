import { attribution } from "../../model/jobStore";

/** Credit for a demo whose music someone else made. */
export function AttributionLine({ compact }: { compact?: boolean } = {}) {
  const a = attribution.value;
  if (!a) return null;
  return (
    <p class={compact ? "xs dim" : "small dim"}>
      Example: <b>{a.title}</b> by {a.artist} ·{" "}
      <a href={a.licenseUrl} rel="license noopener">
        {a.license}
      </a>
      {a.sourceUrl ? (
        <>
          {" · "}
          <a href={a.sourceUrl} rel="noopener">
            source
          </a>
        </>
      ) : null}
      {a.note && !compact ? <> · {a.note}</> : null}
    </p>
  );
}
