export interface PDFPoint{x:number;y:number}
export interface PDFBox{width:number;height:number}
export function pdfViewZoom(value:number){return Number.isFinite(value)?Math.max(1,Math.min(4,value)):1}
export function pdfViewRotation(intrinsic:number,user:number){return ((Math.round((intrinsic+user)/90)*90)%360+360)%360}
export function pdfViewPan(point:PDFPoint,content:PDFBox,viewport:PDFBox):PDFPoint{
 const x=Math.max(0,(content.width-viewport.width)/2),y=Math.max(0,(content.height-viewport.height)/2);
 return {x:Math.max(-x,Math.min(x,point.x))||0,y:Math.max(-y,Math.min(y,point.y))||0};
}
export function pdfZoomAnchor(pan:PDFPoint,previous:number,next:number,anchor:PDFPoint):PDFPoint{
 const ratio=next/previous;return {x:anchor.x-(anchor.x-pan.x)*ratio,y:anchor.y-(anchor.y-pan.y)*ratio};
}
/** Two visible pages plus four fit-only neighbors stay below 8M committed
 * pixels; private staging surfaces stay below the same budget. Dimensions are
 * limited too, for browsers whose canvas edge limit precedes the pixel limit. */
export function pdfViewRaster(width:number,height:number,devicePixelRatio:number,visible:boolean){
 const w=Number.isFinite(width)&&width>0?width:1,h=Number.isFinite(height)&&height>0?height:1;
 const pixels=visible?3_000_000:500_000;
 const requested=Number.isFinite(devicePixelRatio)?Math.max(1,Math.min(3,devicePixelRatio)):1;
 const dpr=Math.min(requested,4096/w,4096/h,Math.sqrt(pixels/(w*h)));
 // Floor bounded canvases so integer rounding cannot exceed the pixel budget.
 return {width:Math.max(1,Math.floor(w*dpr)),height:Math.max(1,Math.floor(h*dpr)),dpr};
}
