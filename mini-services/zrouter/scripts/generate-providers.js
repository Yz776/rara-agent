import { writeFileSync } from "fs";
const providers = [
  {name:"together",url:"https://api.together.xyz/v1",models:["meta-llama/Llama-3.3-70b-Instruct","mistralai/Mixtral-8x7B-Instruct-v0.1"]},
  {name:"perplexity",url:"https://api.perplexity.ai/chat/completions",models:["llama-3.1-sonar-small-128k-online","llama-3.1-sonar-large-128k-online"]},
  {name:"cohere",url:"https://api.cohere.com/v1",models:["command-r-plus","command-r"]},
  {name:"huggingface",url:"https://api-inference.huggingface.co/v1",models:["Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct"]},
  {name:"replicate",url:"https://api.replicate.com/v1",models:["replicate/meta/llama-3.1-405b","replicate/mistral-medium"]},
  {name:"azure",url:"https://{resource}.openai.azure.com/openai/deployments/{deployment}",models:["gpt-4o","gpt-4"]},
  {name:"vertex",url:"https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/models",models:["gemini-1.5-pro","gemini-1.5-flash"]},
  {name:"vercel",url:"https://api.vercel.ai/v1",models:["anthropic/claude-3-opus","anthropic/claude-3-sonnet"]},
  {name:"openrouter",url:"https://openrouter.ai/api/v1",models:["meta-llama/llama-3-8b-instruct","mistralai/mistral-7b-instruct"]},
  {name:"ai21",url:"https://api.ai21.com/studio/v1",models:["jamba-1.5-mini","jamba-1.5-large"]},
  {name:"mistral",url:"https://api.mistral.ai/v1",models:["mistral-large-latest","mistral-medium-latest"]},
  {name:"octoml",url:"https://llm.api.octoml.ai/v1",models:["meta-llama-Llama-2-13b-chat-hf","mistral-tiny"]},
  {name:"anyscale",url:"https://api.endpoints.anyscale.com/v1",models:["meta-llama/Llama-2-70b-chat-hf","mixtral-8x7b-instruct-v0.1"]},
  {name:"runpod",url:"https://api.runpod.ai/v2",models:["GPT-NeoX-20B","MPT-30B"]},
  {name:"modal",url:"https://api.modal.run/v1",models:["codellama/codellama-34b-instruct","databricks/dbrx-instruct"]}
];
for(const p of providers){
  const models=p.models.map(m=>({id:m,object:"model",owned_by:p.name,capabilities:{streaming:true,tools:true,vision:false,reasoning:m.includes("gemini")||m.includes("jamba")?true:false}}));
  const content=`import crypto from "node:crypto";
import type {AIProvider,ChatCompletionChunk,ChatCompletionRequest,ChatCompletionResponse} from "../types";
import{fetchWithRetry} from "../utils/retry";
const BASE_URL="${p.url}";
export class ${p.charAt(0).toUpperCase()+p.slice(1)}Executor implements AIProvider{
  id:string;name:string;protocol="openai" as const;category:"api_key"| "free_tier"| "oauth"| "self_hosted"="api_key";
  protected apiKey:string;protected baseUrl:string;
  constructor(o:{id?:string;name?:string;baseUrl?:string;apiKey?:string}={}){this.id=o.id??"${p}";this.name=o.name??"${p.charAt(0).toUpperCase()+p.slice(1)}";this.baseUrl=(o.baseUrl??BASE_URL).replace(/\/$/,"");this.apiKey=o.apiKey??"";}
  updateApiKey(k:string):void{if(k)this.apiKey=k;}
  getHeaders(s:boolean):Record<string,string>{return{"Content-Type":"application/json",Authorization:\`Bearer \${this.apiKey}\`,Accept:s?"text/event-stream":"*/*","User-Agent":"KRouter/2.0"};}
  async listModels():Promise<any[]>{return ${JSON.stringify(models)}.filter(Boolean);};
  buildUrl(p:string):string{return\`\${this.baseUrl}\${p}\`;};
  async chatCompletion(r:ChatCompletionRequest):Promise<ChatCompletionResponse>{let t="";for await(c of this.chatCompletionStream(req))t+=c.choices?.[0]?.delta?.content??"";return{id:`chatcmpl-${"{crypto.randomUUID()}"}`,object:"chat.completion",created:Math.floor(Date.now()/1000),model:r.model,choices:[{index:0,message:{role:"assistant",content:t},finish_reason:"stop"}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}};}
  async *chatCompletionStream(r:ChatCompletionRequest):AsyncGenerator<ChatCompletionChunk>{const u=this.buildUrl("/chat/completions");const b={...r,model:r.model.replace(/^${p}\//,""),stream:true};const res=await fetchWithRetry(u,b,this.getHeaders(true));if(!res.ok)throw new Error(\`${p} error (\${res.status}): \${await res.text()}\`);if(!res.body)throw new Error("No response body");const e=new TextDecoder();let buf="";for await(const c of res.body){buf+=e.decode(c,{stream:true});const lines=buf.split("\n");buf=lines.pop()??"";for(const l of lines){if(l.startsWith("data:")){const j=l.substring(5).trim();if(j==="[DONE]")continue;try{const d=JSON.parse(j);yield{id:d.id,object:d.object,created:d.created,model:r.model,choices:d.choices}}catch{}}}yield{id:`chatcmpl-${"{crypto.randomUUID()}"}`,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:r.model,choices:[{index:0,delta:{},finish_reason:"stop"}]};}
}`;
  writeFileSync(`src/executors/${p}.ts`,content);console.log(`Created ${p}.ts`);
}
console.log("Done!");
