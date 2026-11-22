// 把 agentry CLI 的 --json 计划转成 baw 预览：node scripts/baw-preview-plan.cjs <plan.json> <name> [发起地址]（默认 anndy.ai）
const fs=require("fs"),path=require("path");const {execFileSync}=require("child_process");const {ethers}=require("ethers");
const [planFile,name]=process.argv.slice(2);const plan=JSON.parse(fs.readFileSync(planFile,"utf8"));
const p=new ethers.JsonRpcProvider("https://bsc-dataseed.bnbchain.org",56);const from=process.argv[4]||"0x7c70c1CF10D420c8A4a9eF3488617E766b24bDB3";
(async()=>{let i=0;for(const s of plan.steps){i++;const est=await p.estimateGas({from,to:s.to,data:s.data,value:BigInt(s.value)});
const a=["contract-call","preview","--binanceChainId","56","--from",from,"--to",s.to,"--value",String(s.value),"--inputData",s.data,"--gasLimit",String(est*13n/10n),"--json"];
const af=path.join(path.dirname(planFile),name+".args"+i+".json");fs.writeFileSync(af,JSON.stringify(a));
const j=JSON.parse(execFileSync(process.execPath,["scripts/baw-run.mjs",af],{encoding:"utf8"}));
console.log(name,"#"+i,s.summary,"| ok",j.success,"| requestId",j.data&&j.data.requestId,"| sim",j.data&&j.data.simulationResult.simulationCode,"| risks",JSON.stringify(j.data&&j.data.risks.riskDetails),"| auth",JSON.stringify(j.data&&j.data.simulationResult.authorityChanges),"| bal",JSON.stringify(j.data&&j.data.simulationResult.balanceChanges));}})().catch(e=>console.error("ERR",e.shortMessage||e.message));
