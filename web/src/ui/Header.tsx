import { AUDIOSAW } from "../config";
import { SignInButton } from "./account/SignInButton";
import { navigate, route } from "./router";

export function Header() {
  return (
    <header class="siteheader">
      <a
        class="siteheader__brand"
        href="#/"
        onClick={(e) => {
          e.preventDefault();
          navigate("home");
        }}
      >
        <span aria-hidden="true">🎛️</span>
        StemFlipper
        <span class="siteheader__by">
          by <span style={{ textDecoration: "underline" }}>AudioSaw</span>
        </span>
      </a>
      <span class="spacer" />
      {route.value !== "home" ? (
        <a class="small dim" href={AUDIOSAW.home} style={{ marginRight: "4px" }}>
          More audio tools
        </a>
      ) : null}
      <SignInButton />
    </header>
  );
}
