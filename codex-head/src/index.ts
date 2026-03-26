const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const warningType = typeof args[0] === "string"
    ? args[0]
    : typeof warning === "string"
      ? ""
      : warning.name;
  const warningMessage = typeof warning === "string"
    ? warning
    : warning.message;

  if (warningType === "ExperimentalWarning" && /SQLite is an experimental feature/i.test(warningMessage)) {
    return;
  }

  return (originalEmitWarning as (...innerArgs: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

require("./cliMain");
