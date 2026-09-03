// Stable browser-side bootstrap for authenticated Control UI plugin frames.
// Keep this module free of Node.js imports so the same source can be embedded
// by the UI and hashed by the Gateway's document CSP.

export const CAPABILITY_BRIDGE_BOOTSTRAP_MESSAGE = "openclaw:capability-bridge-bootstrap";
export const CAPABILITY_BRIDGE_BOOTSTRAP_MOUNTED_MESSAGE =
  "openclaw:capability-bridge-bootstrap-mounted";
const CAPABILITY_BRIDGE_BOOTSTRAP_ID_ATTRIBUTE = "data-openclaw-capability-bridge-bootstrap-id";

const CAPABILITY_BRIDGE_BOOTSTRAP_ID_PATTERN = "^[a-f0-9]{32}$";
const CAPABILITY_BRIDGE_BOOTSTRAP_ID_RE = new RegExp(CAPABILITY_BRIDGE_BOOTSTRAP_ID_PATTERN);

/**
 * The executable body is deliberately stable. Per-mount provenance stays in
 * the script element's data attribute so one exact CSP hash can authorize the
 * host-owned bootstrap without allowing arbitrary inline script.
 */
export const CAPABILITY_BRIDGE_BOOTSTRAP_SOURCE = [
  "(()=>{",
  "const script=document.currentScript;",
  `const id=script?.getAttribute("${CAPABILITY_BRIDGE_BOOTSTRAP_ID_ATTRIBUTE}");`,
  `if(!(script instanceof HTMLScriptElement)||!id||!/${CAPABILITY_BRIDGE_BOOTSTRAP_ID_PATTERN}/.test(id))return;`,
  "const channel=new MessageChannel();const port=channel.port1;",
  'port.onmessage=(event)=>window.postMessage({type:"openclaw:capability-bridge-receive",protocolVersion:1,payload:event.data},"*");',
  "port.start();",
  'window.addEventListener("message",(event)=>{const data=event.data;if(event.source===window&&data?.type==="openclaw:capability-bridge-send"&&data.protocolVersion===1)port.postMessage(data.payload)});',
  `window.addEventListener("load",()=>parent.postMessage({type:"${CAPABILITY_BRIDGE_BOOTSTRAP_MOUNTED_MESSAGE}",id},"*"),{once:true});`,
  "script.remove();",
  `parent.postMessage({type:"${CAPABILITY_BRIDGE_BOOTSTRAP_MESSAGE}",id},"*",[channel.port2]);`,
  "})()",
].join("");

export function buildControlUiCapabilityBridgeBootstrap(bootstrapId: string): string {
  if (!CAPABILITY_BRIDGE_BOOTSTRAP_ID_RE.test(bootstrapId)) {
    throw new Error("invalid capability bridge bootstrap id");
  }
  return `<script ${CAPABILITY_BRIDGE_BOOTSTRAP_ID_ATTRIBUTE}="${bootstrapId}">${CAPABILITY_BRIDGE_BOOTSTRAP_SOURCE}</script>`;
}
