const PUSH_COM_INTERVAL_LINE = "SET OPTIONS PushComInterval=5";

// eSSL/ZKTeco terminals re-poll getrequest every ~60s by default, which is too
// slow to deliver a queued gate-lock command. Appending the PushComInterval
// option to every getrequest reply forces a tight 5s cadence so a queued
// command downloads within seconds instead of a full minute.
function buildGetRequestResponse(command) {
  const lines = [];
  if (command && command.commandId != null && command.commandString) {
    lines.push(`C:${command.commandId}:${command.commandString}`);
  }
  lines.push(PUSH_COM_INTERVAL_LINE);
  return lines.join("\n") + "\n";
}

function buildCdataResponse(results) {
  const count = Array.isArray(results) ? results.length : 0;
  return count > 0 ? `OK: ${count}` : "OK";
}

module.exports = { buildGetRequestResponse, buildCdataResponse };