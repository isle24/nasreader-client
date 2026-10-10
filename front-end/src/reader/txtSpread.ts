/** Dimensions are ink-window pixels. Paper padding remains outside this geometry. */
export function txtSpreadGeometry(input:{width:number;viewportWidth:number;fontSize:number;paginated:boolean;finePointer:boolean}){
  const width=Number.isFinite(input.width)?Math.max(1,input.width):1;
  const size=Number.isFinite(input.fontSize)?Math.max(16,Math.min(36,input.fontSize)):20;
  const candidateGap=Math.max(64,Math.min(96,size*4));
  const columns=input.paginated&&input.finePointer&&input.viewportWidth>=1000&&width>=size*24+candidateGap?2:1;
  const gap=columns===2?candidateGap:0;
  const columnWidth=(width-gap)/columns;
  // Two columns advance past two gutters. The last gutter is outside the visible
  // window, so it must be included in the transform/table stride, not clipped ink.
  return {columns,columnWidth,gap,stride:columns*(columnWidth+gap)};
}
