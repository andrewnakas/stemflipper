/** The shell: header, the current screen, and transient messages. */

import { useEffect } from "preact/hooks";
import { startClock } from "../model/playback";
import { Toasts } from "./components/Toast";
import { Header } from "./Header";
import { Landing } from "./landing/Landing";
import { ListenScreen } from "./listen/ListenScreen";
import { route } from "./router";
import { RunScreen } from "./run/RunScreen";
import { Studio } from "./studio/Studio";

export function App() {
  useEffect(() => startClock(), []);

  const where = route.value;
  const studio = where === "studio";

  return (
    <div class={"app" + (studio ? " app--studio" : "")}>
      {studio ? null : <Header />}
      {where === "home" ? <Landing /> : null}
      {where === "run" ? <RunScreen /> : null}
      {where === "listen" ? <ListenScreen /> : null}
      {studio ? <Studio /> : null}
      <Toasts />
    </div>
  );
}
