# Installed builds

Commit finished changes before building an executable or installer that will be installed or shipped.
Build from a clean working tree with `ROBO_BUILD_STRICT=1`, so the settings footer identifies the exact commit without a `+`.
Development/test builds may be dirty. After the final commit, rebuild the frontend and native executable, then install that new build.
