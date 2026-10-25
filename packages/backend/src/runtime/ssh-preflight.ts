import { spawn } from "node:child_process";
import {
	isSupportedRuntimeNode,
	type RemoteConnectionStatus,
	RUNTIME_NODE_RANGE,
	type SshPreflight,
} from "@percho/shared";
import { sshArguments, validateSshAlias } from "./ssh-arguments";

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Bounded one-shot OpenSSH process. Cancellation never signals the daemon or unrelated SSH processes. */
export async function runSsh(args: string[], signal: AbortSignal, timeoutMs = 25_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal });
		const output: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let failure: Error | undefined;
		const timer = setTimeout(() => {
			failure = new Error("SSH connection timed out");
			child.kill();
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1024 * 1024) {
				failure = new Error("SSH response exceeds limit");
				child.kill();
			} else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16384) stderr = (stderr + chunk.toString("utf8")).slice(0, 16384);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (failure || code !== 0) reject(failure ?? new Error(stderr.trim() || `SSH exited (${code})`));
			else resolve(Buffer.concat(output).toString("utf8"));
		});
	});
}

// Runs without creating directories, importing the runtime/SDK, or loading project resources.
const probe = `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),net=require('node:net');
(async()=>{
 const home=fs.realpathSync(os.homedir()), rawRoot=path.join(home,'.percho');
 const root=fs.existsSync(rawRoot)?fs.realpathSync(rawRoot):rawRoot;
 const rawAgent=path.join(root,'agent'),agentDir=fs.existsSync(rawAgent)?fs.realpathSync(rawAgent):rawAgent;
 const commands=Object.fromEntries(['sh','tar','sha256sum','flock','setsid','git'].map(name=>[name,cp.spawnSync('sh',['-c','command -v "$1" >/dev/null','probe',name]).status===0]));
 let environmentId;try {environmentId=JSON.parse(fs.readFileSync(path.join(agentDir,'environment.json'),'utf8')).environmentId;}catch(e){if(e.code!=='ENOENT')throw e;}
 const suffix=crypto.createHash('sha256').update(process.getuid()+':'+root).digest('hex').slice(0,12);
 const socketPath=path.join(root,'run',suffix+'.sock');
 const status=await new Promise(resolve=>{
  if(!fs.existsSync(socketPath))return resolve({serviceState:'stopped'});
  const socket=net.connect(socketPath);let text='';
  const finish=value=>{clearTimeout(timer);socket.destroy();resolve(value);};
  const timer=setTimeout(()=>finish({serviceState:'unreachable'}),2000);
  socket.on('error',()=>finish({serviceState:'unreachable'}));
  socket.on('connect',()=>socket.write(JSON.stringify({type:'inspect',id:'probe'})+'\\n'));
  socket.on('data',chunk=>{text+=chunk;if(text.length>1048576)return finish({serviceState:'unreachable'});if(text.includes('\\n')){try{const frame=JSON.parse(text.split('\\n')[0]);finish(frame.result?{serviceState:'running',service:frame.result}:{serviceState:'unreachable'});}catch{finish({serviceState:'unreachable'});}}});
 });
 let installedReleaseId;try{const v=JSON.parse(fs.readFileSync(path.join(root,'installed.json'),'utf8'));if(!/^v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(v.releaseId))throw new Error('Invalid installed release');installedReleaseId=v.releaseId;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!installedReleaseId&&fs.existsSync(path.join(root,'releases/development/entry.mjs')))installedReleaseId='development';
 console.log(JSON.stringify({uid:process.getuid?.(),home,agentDir,environmentId,node:fs.realpathSync(process.execPath),nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime||'',commands,installedReleaseId,installed:!!installedReleaseId&&fs.existsSync(path.join(root,'releases',installedReleaseId,'entry.mjs')),...status}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
`;

export async function preflightSsh(alias: string, signal: AbortSignal): Promise<SshPreflight> {
	validateSshAlias(alias);
	const effective = await runSsh(["-G", "--", alias], signal);
	const fields = new Map(
		effective.split(/\r?\n/).map((line) => {
			const index = line.indexOf(" ");
			return [line.slice(0, index), line.slice(index + 1)] as const;
		}),
	);
	const target = {
		hostname: fields.get("hostname") ?? "",
		user: fields.get("user") ?? "",
		port: fields.get("port") ?? "",
	};
	if (!target.hostname || !target.user || !target.port)
		throw new Error("Invalid effective SSH configuration");
	const output = await runSsh(
		sshArguments(
			alias,
			`command -v node >/dev/null 2>&1 || { echo 'NODE_REQUIRED: Install Node ${RUNTIME_NODE_RANGE}, visible to non-interactive SSH; see https://nodejs.org/en/download' >&2; exit 64; }; exec node -e ${shellQuote(probe)}`,
		),
		signal,
	);
	const result = { ...JSON.parse(output), alias, target } as SshPreflight;
	if (
		!Number.isSafeInteger(result.uid) ||
		result.uid < 0 ||
		!result.home?.startsWith("/") ||
		!result.node?.startsWith("/") ||
		!result.commands ||
		typeof result.installed !== "boolean"
	)
		throw new Error("Invalid remote preflight response");
	return result;
}

export function checkSshRequirements(probe: SshPreflight): void {
	if (!isSupportedRuntimeNode(probe.nodeVersion))
		throw new Error(
			`NODE_REQUIRED: Install Node ${RUNTIME_NODE_RANGE} in the non-interactive SSH environment; https://nodejs.org/en/download`,
		);
	if (probe.platform !== "linux" || !["x64", "arm64"].includes(probe.arch) || !probe.glibc)
		throw new Error("REQUIREMENTS: Requires glibc Linux x64 or ARM64; musl/Alpine is unsupported");
	const [glibcMajor = 0, glibcMinor = 0] = probe.glibc.split(".").map(Number);
	if (glibcMajor < 2 || (glibcMajor === 2 && glibcMinor < 35))
		throw new Error("REQUIREMENTS: Requires glibc 2.35 or newer");
	const missing = ["sh", "tar", "sha256sum", "flock", "setsid"].filter((name) => !probe.commands[name]);
	if (missing.length) throw new Error(`REQUIREMENTS: Missing commands: ${missing.join(", ")}`);
}

export function sshFailureKind(error: unknown): NonNullable<RemoteConnectionStatus["errorKind"]> {
	const text = error instanceof Error ? error.message : String(error);
	if (/host key verification|REMOTE HOST IDENTIFICATION|host key has changed/i.test(text)) return "hostKey";
	if (/permission denied|authentication failed|no supported authentication/i.test(text))
		return "authentication";
	if (/identity changed|already bound/i.test(text)) return "identity";
	if (/incompatible|INCOMPATIBLE/i.test(text)) return "incompatible";
	if (/NOT_INSTALLED/.test(text)) return "notInstalled";
	if (/NODE_REQUIRED|REQUIREMENTS/.test(text)) return "requirements";
	if (/already controlled|BUSY|owner is active/i.test(text)) return "busy";
	if (
		/timed out|connection (closed|reset|refused)|network is unreachable|no route to host|could not resolve hostname|broken pipe|socket closed|transport closed/i.test(
			text,
		)
	)
		return "network";
	return "other";
}
