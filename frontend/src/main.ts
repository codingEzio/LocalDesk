import { mount } from "svelte";
import "./style.css";
import "./chat.css";
import "./sidebar.css";
import { readStartPage } from "./ui";
const params = new URLSearchParams(location.search);
if (
  location.pathname === "/" &&
  !["view", "chat", "module"].some((key) => params.has(key))
) {
  const landing = readStartPage();
  if (landing === "workbench") history.replaceState(null, "", "/workbench");
  else if (landing === "activity") {
    history.replaceState(null, "", "/?view=activity");
  }
}
const { default: App } = location.pathname === "/workbench"
  ? await import("./Workbench.svelte")
  : await import("./App.svelte");
mount(App, { target: document.getElementById("app")! });
