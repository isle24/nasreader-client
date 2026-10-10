interface AccessClient {post<T=any>(path:string,body?:unknown):Promise<T>}
export async function checkBookAccess(client:AccessClient,ids:number[]):Promise<{denied:number[];revision:unknown}>{
 const unique=[...new Set(ids.filter(id=>Number.isSafeInteger(id)&&id>0))],denied:number[]=[];let revision:unknown=null;
 for(let i=0;i<unique.length;i+=100){const response=await client.post<{items:{id:number;allowed:boolean}[];revision:unknown}>('/books/access-check',{ids:unique.slice(i,i+100)});revision=response.revision;for(const item of response.items??[])if(item.allowed===false&&unique.includes(item.id)&&!denied.includes(item.id))denied.push(item.id)}
 return {denied,revision};
}
