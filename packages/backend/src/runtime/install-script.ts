// Self-contained bootstrap. Runs with preflight's absolute Node, before any runtime exists.
// stdin is ONLY the trusted release archive; it is not a general file transfer channel.
export const INSTALL_SCRIPT = String.raw`
const fs=require('node:fs/promises'),C=require('node:fs').constants,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),z=require('node:zlib'),{pipeline}=require('node:stream/promises');
const metadata=JSON.parse(process.argv[1]);
let staging,lock,owner;
async function privateDir(p){await fs.mkdir(p,{recursive:true,mode:0o700});const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Unsafe private installation directory');}
async function execute(file,args,options={}){return new Promise((resolve,reject)=>cp.execFile(file,args,{timeout:90000,maxBuffer:1048576,...options},(e,out)=>e?reject(e):resolve(out)));}
(async()=>{
 if(process.platform!=='linux'||!['arm64','x64'].includes(process.arch)||metadata.arch!==process.arch||!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.releaseId)||!Number.isSafeInteger(metadata.bytes)||metadata.bytes<1||metadata.bytes>268435456||!(/^[a-f0-9]{64}$/).test(metadata.sha256))throw Error('Invalid installation metadata/platform');
 const rawRoot=path.join(await fs.realpath(os.homedir()),'.percho');
 await privateDir(rawRoot);const root=await fs.realpath(rawRoot);for(const d of ['staging','releases','run'])await privateDir(path.join(root,d));
 lock=await fs.open(path.join(root,'run/install.lock'),C.O_CREAT|C.O_RDWR|C.O_NOFOLLOW,0o600);const ls=await lock.stat();if(!ls.isFile()||ls.uid!==process.getuid())throw Error('Unsafe install lock');await lock.chmod(0o600);
 async function acquire(file){await new Promise((resolve,reject)=>{const child=cp.spawn('flock',['-n','-E','75','3'],{stdio:['ignore','ignore','pipe',file.fd]});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('INSTALL_BUSY: Runtime or installer owns the target')));});}
 await acquire(lock);
 const suffix=crypto.createHash('sha256').update(process.getuid()+':'+root).digest('hex').slice(0,12);
 owner=await fs.open(path.join(root,'run/owner.lock'),C.O_CREAT|C.O_RDWR|C.O_NOFOLLOW,0o600);const ownStat=await owner.stat();if(!ownStat.isFile()||ownStat.uid!==process.getuid())throw Error('Unsafe owner lock');await owner.chmod(0o600);await acquire(owner);
 staging=await fs.mkdtemp(path.join(root,'staging/install-'));await fs.chmod(staging,0o700);
 const archive=path.join(staging,'archive.tar.gz'),file=await fs.open(archive,'wx',0o600);let bytes=0;const digest=crypto.createHash('sha256');
 try{for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>metadata.bytes)throw Error('Archive exceeds expected size');digest.update(chunk);await file.writeFile(chunk);}}finally{await file.close();}
 if(bytes!==metadata.bytes||digest.digest('hex')!==metadata.sha256)throw Error('Archive size or SHA256 mismatch');
 const candidate=path.join(staging,'package');await privateDir(candidate);
 // Validate every ustar header, then stream regular files into a fresh, link-free directory.
 const input=require('node:fs').createReadStream(archive),gunzip=z.createGunzip();input.pipe(gunzip);input.on('error',e=>gunzip.destroy(e));
 let buffer=Buffer.alloc(0),remaining=0,padding=0,current,expanded=0,count=0,ended=false,zero=0;const names=new Set();
 const string=b=>{const i=b.indexOf(0);return b.subarray(0,i<0?b.length:i).toString('utf8');};
 const octal=b=>{const s=string(b).trim();if(!/^[0-7]+$/.test(s))throw Error('Invalid tar number');const n=parseInt(s,8);if(!Number.isSafeInteger(n))throw Error('Tar number exceeds limit');return n;};
 try{for await(const chunk of gunzip){expanded+=chunk.length;if(expanded>1073741824)throw Error('Expanded archive exceeds limit');buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length){
   if(remaining){const n=Math.min(remaining,buffer.length);await current.writeFile(buffer.subarray(0,n));buffer=buffer.subarray(n);remaining-=n;if(!remaining){await current.close();current=undefined;}continue;}
   if(padding){const n=Math.min(padding,buffer.length);buffer=buffer.subarray(n);padding-=n;continue;}
   if(buffer.length<512)break;const h=buffer.subarray(0,512);buffer=buffer.subarray(512);
   if(h.every(v=>v===0)){zero++;ended=true;continue;}if(ended)throw Error('Nonzero data after tar terminator');
   let sum=0;for(let i=0;i<512;i++)sum+=(i>=148&&i<156)?32:h[i];if(sum!==octal(h.subarray(148,156)))throw Error('Invalid tar checksum');
   if(string(h.subarray(257,263))!=='ustar')throw Error('Only ustar archives are supported');
   const name=[string(h.subarray(345,500)),string(h.subarray(0,100))].filter(Boolean).join('/').replace(/^\.\//,'').replace(/\/$/,'');
   const size=octal(h.subarray(124,136)),mode=octal(h.subarray(100,108)),type=h[156];
   if(![0,48,53].includes(type)||mode&0o7000||size>268435456||(++count)>100000)throw Error('Unsafe tar entry type/mode/size');
   if(!name||name==='.') {if(type!==53||size)throw Error('Invalid tar root');continue;}
   if(name.startsWith('/')||name.includes('\\')||name.includes('\ufffd')||name.split('/').some(p=>!p||p==='.'||p==='..')||Buffer.byteLength(name)>512||names.has(name))throw Error('Unsafe or duplicate archive path');names.add(name);
   const target=path.join(candidate,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
   if(type===53){if(size)throw Error('Nonempty directory');await fs.mkdir(target,{recursive:true,mode:0o700});}
   else{current=await fs.open(target,'wx',mode&0o111?0o700:0o600);remaining=size;padding=(512-size%512)%512;if(!size){await current.close();current=undefined;}}
  }
 }}finally{if(current)await current.close();input.destroy();gunzip.destroy();}
 if(remaining||padding||buffer.length||zero<2)throw Error('Truncated tar archive');
 const checked=JSON.parse(await execute(process.execPath,[path.join(candidate,'entry.mjs'),'check']));
 if(!checked.ok||checked.releaseId!==metadata.releaseId||checked.arch!==metadata.arch||checked.protocol!==metadata.protocol)throw Error('Candidate release check failed');
 const destination=path.join(root,'releases',metadata.releaseId),receipt={releaseId:metadata.releaseId,sha256:metadata.sha256,arch:metadata.arch};
 // Immutable version directories: a conflicting build never replaces an installed package.
 try{await fs.lstat(destination);const old=JSON.parse(await fs.readFile(path.join(destination,'installation.json'),'utf8'));if(JSON.stringify(old)!==JSON.stringify(receipt))throw Error('Installed release has different content; it was preserved');}
 catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(path.join(candidate,'installation.json'),JSON.stringify(receipt),{flag:'wx',mode:0o600});await fs.rename(candidate,destination);}
 const pointer=path.join(staging,'installed.json');await fs.writeFile(pointer,JSON.stringify(receipt),{flag:'wx',mode:0o600});await fs.rename(pointer,path.join(root,'installed.json'));
 console.log(JSON.stringify({installed:true,...receipt}));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{if(staging)await fs.rm(staging,{recursive:true,force:true});if(owner)await owner.close();if(lock)await lock.close();});
`;
