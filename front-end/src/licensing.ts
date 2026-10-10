export type LicenseStatus={project_type:string;license_id?:number;device_id?:number;max_devices?:number;state:string;instance_id:string;public_key:string;lease_until_ms:number;license_expires_at_ms:number;last_error?:string};
export function mayReadWithLease(status:Pick<LicenseStatus,'state'|'lease_until_ms'>|null,now=Date.now()):boolean{
 return status!==null&&(status.state==='active'||status.state==='network_grace')&&Number.isFinite(status.lease_until_ms)&&now<status.lease_until_ms;
}
export function licenseDate(ms:number):string{return ms?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(ms))+'（北京时间）':'永久';}
