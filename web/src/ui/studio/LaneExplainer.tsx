/** Three faders per track needs one sentence of explanation, permanently visible. */
export function LaneExplainer() {
  return (
    <div class="lane-explainer">
      <span><b>Original</b> the separated stem</span>
      <span><b>Synth</b> the notes played on a synth</span>
      <span><b>Sampler</b> the notes played on samples cut from this song</span>
      <span class="spacer" />
      <span>Blend them with the faders.</span>
    </div>
  );
}
