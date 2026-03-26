let _dryRun = process.env.JIG_DRY_RUN === "1"

export function setDryRun(v: boolean) {
  _dryRun = v
  if (v) process.env.JIG_DRY_RUN = "1"
  else delete process.env.JIG_DRY_RUN
}

export function isDryRun() { return _dryRun }
