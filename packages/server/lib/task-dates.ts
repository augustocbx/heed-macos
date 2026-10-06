/** Only fully specified calendar dates can be proposed automatically. Relative and numeric
 * locale-ambiguous phrases stay as review text; the model never chooses their interpretation. */
export function explicitTaskDate(phrase:string):string|null {
 const normalized=phrase.normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();
 if(/^\d{4}-\d{2}-\d{2}$/.test(normalized))return valid(normalized);
 const months=[
  ['january','janeiro','janvier','januar'],['february','fevereiro','fevrier','februar'],
  ['march','marco','mars','marz'],['april','abril','avril'],['may','maio','mai'],
  ['june','junho','juin','juni'],['july','julho','juillet','juli'],['august','agosto','aout'],
  ['september','setembro','septembre'],['october','outubro','octobre','oktober'],
  ['november','novembro','novembre'],['december','dezembro','decembre','dezember'],
 ];
 const dayFirst=/^(\d{1,2})(?:st|nd|rd|th|er|\.)?\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})$/.exec(normalized);
 const monthFirst=/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/.exec(normalized);
 if(!dayFirst&&!monthFirst)return null;
 const day=dayFirst?.[1]||monthFirst![2];const month=dayFirst?.[2]||monthFirst![1];const year=dayFirst?.[3]||monthFirst![3];
 const monthIndex=months.findIndex(names=>names.includes(month));if(monthIndex<0)return null;
 return valid(`${year}-${String(monthIndex+1).padStart(2,'0')}-${day.padStart(2,'0')}`);
}
function valid(value:string):string|null {
 const parsed=new Date(`${value}T12:00:00Z`);
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?value:null;
}
