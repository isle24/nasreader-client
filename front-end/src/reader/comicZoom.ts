export interface ZoomBounds{viewWidth:number;viewHeight:number;contentWidth:number;contentHeight:number}
export function shouldWheelZoom(mode:string,ctrl:boolean,meta:boolean,interactive:boolean):boolean{return !interactive&&(mode==='paginated'||ctrl||meta)}
export function clampComicPan(pan:{x:number;y:number},zoom:number,bounds:ZoomBounds){if(zoom<=1)return {x:0,y:0};const x=Math.abs((bounds.contentWidth*zoom-bounds.viewWidth)/2),y=Math.abs((bounds.contentHeight*zoom-bounds.viewHeight)/2);return {x:Math.max(-x,Math.min(x,pan.x)),y:Math.max(-y,Math.min(y,pan.y))}}
export function zoomUnderPointer(current:{zoom:number;pan:{x:number;y:number}},pointer:{x:number;y:number},delta:number,bounds:ZoomBounds){
 const zoom=Math.max(1,Math.min(4,current.zoom*Math.exp(-delta*.002))),ratio=zoom/current.zoom;
 return {zoom,pan:clampComicPan({x:pointer.x-(pointer.x-current.pan.x)*ratio,y:pointer.y-(pointer.y-current.pan.y)*ratio},zoom,bounds)};
}
