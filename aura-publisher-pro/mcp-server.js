import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';import {z} from 'zod';
const s=new McpServer({name:'aura-publisher-pro',version:'2.0.0'});const call=async(path,body)=>{const r=await fetch(`${process.env.AURA_API_URL}${path}`,{method:'POST',headers:{'Content-Type':'application/json','x-aura-token':process.env.ADMIN_TOKEN||''},body:JSON.stringify(body)});return await r.json()};
s.tool('validate_post','Validate an Aura structured post before publishing',{post:z.any()},async({post})=>({content:[{type:'text',text:JSON.stringify(await call('/api/validate',{post}),null,2)}]}));
s.tool('test_wordpress','Test a WordPress connection',{wordpress:z.any()},async({wordpress})=>({content:[{type:'text',text:JSON.stringify(await call('/api/wp/test',{wordpress}),null,2)}]}));
await s.connect(new StdioServerTransport());
