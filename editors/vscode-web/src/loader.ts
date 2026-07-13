import "./style.css";

void import("./main").catch((error: unknown) => {
  const root = document.querySelector<HTMLElement>("#workbench");
  if (root) {
    root.className = "fatal-error";
    root.textContent = error instanceof Error ? error.message : String(error);
  }
  console.error(error);
});
