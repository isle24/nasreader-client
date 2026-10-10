export type PDFLayout='book'|'single';
export type PDFColumns=1|2;
export interface PDFPageRange{start:number;end:number}

function pageNumber(page:number,total:number){return Math.max(1,Math.min(Math.max(1,total),Math.floor(page)||1))}

export function pdfSpreadColumns(layout:PDFLayout,mode:string,finePointer:boolean,width:number,total:number):PDFColumns{
 return layout==='book'&&mode==='paginated'&&finePointer&&width>=800&&total>=2?2:1;
}
export function pdfPageRange(page:number,total:number,columns:PDFColumns):PDFPageRange{
 const current=pageNumber(page,total),start=columns===2?current-(current-1)%2:current;
 return {start,end:Math.min(Math.max(1,total),start+columns-1)};
}
/** Boundary turns retain the exact current page, including right-page focus. */
export function pdfTurnPage(page:number,total:number,columns:PDFColumns,direction:1|-1){
 const {start,end}=pdfPageRange(page,total,columns);
 if(direction>0)return end>=total?page:end+1;
 return start<=1?page:Math.max(1,start-columns);
}
/** Only the current group and its immediate neighbors have mounted canvases. */
export function pdfCachePages(page:number,total:number,columns:PDFColumns){
 if(total<1)return [];
 const {start}=pdfPageRange(page,total,columns);
 const first=Math.max(1,start-columns),last=Math.min(total,start+columns*2-1);
 return Array.from({length:last-first+1},(_,i)=>first+i);
}
export function fitPDFSpread(width:number,height:number,columns:PDFColumns){
 const padding=12,gap=columns===2?20:0,ratio=210/297;
 const availableWidth=Math.max(1,width-padding*2-gap),availableHeight=Math.max(1,height-padding*2);
 const paperHeight=Math.min(availableHeight,availableWidth/columns/ratio),paperWidth=paperHeight*ratio;
 const pagePadding=Math.min(10,paperWidth/10,paperHeight/10),footerHeight=Math.min(26,paperHeight/8);
 return {paperWidth,paperHeight,padding,gap,pagePadding,footerHeight,contentWidth:paperWidth-pagePadding*2,contentHeight:paperHeight-pagePadding*2-footerHeight};
}
/** Dimensions use the rotated PDF viewport, so landscape/rotation are contained. */
export function containPDFPage(width:number,height:number,availableWidth:number,availableHeight:number){
 const scale=Math.min(availableWidth/width,availableHeight/height),fittedWidth=width*scale,fittedHeight=height*scale;
 return {scale,width:fittedWidth,height:fittedHeight,left:(availableWidth-fittedWidth)/2,top:(availableHeight-fittedHeight)/2};
}
export function pdfRasterSize(width:number,height:number,devicePixelRatio:number){
 const dpr=Math.max(1,Math.min(3,Number.isFinite(devicePixelRatio)?devicePixelRatio:1));
 return {width:Math.ceil(width*dpr),height:Math.ceil(height*dpr),dpr};
}
