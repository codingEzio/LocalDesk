const bundles = import.meta.glob("./locales/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<string, string>>;
export const translations = Object.fromEntries(
  Object.entries(bundles).map((
    [path, value],
  ) => [path.split("/").pop()!.replace(".json", ""), value]),
);
export function readStartPage() {
  const value = localStorage.getItem("localdesk-start-page");
  return ["overview", "workbench", "activity"].includes(value || "")
    ? value!
    : "overview";
}
export function trapFocus(node: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null;
  node.focus();
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const list = [
      ...node.querySelectorAll<HTMLElement>(
        "button:not(:disabled),select,input,textarea,a",
      ),
    ].filter((el) => el.getClientRects().length);
    if (
      e.shiftKey &&
      (document.activeElement === list[0] || document.activeElement === node)
    ) {
      e.preventDefault();
      list.at(-1)?.focus();
    } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
      e.preventDefault();
      list[0]?.focus();
    }
  };
  node.addEventListener("keydown", key);
  return {
    destroy() {
      node.removeEventListener("keydown", key);
      previous?.focus();
    },
  };
}
