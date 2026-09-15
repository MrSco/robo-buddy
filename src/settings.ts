import { main } from "./settings/index";

export * from "./settings/types";
export * from "./settings/index";

main().catch((err) => {
  const status = document.getElementById("status");
  if (status) status.textContent = `Settings failed to load: ${err}`;
});
