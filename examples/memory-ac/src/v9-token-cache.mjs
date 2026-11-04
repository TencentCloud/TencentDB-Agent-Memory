// Exact memoization of independent tokenizer regex pieces. No BPE engine changes.
// The final assembled prompt is still verified with the original encoder by callers.
export function exactTokenCounter(encoding,{maxPieces=25000,maxChars=1000000}={}){
 if(!Number.isInteger(maxPieces)||maxPieces<1||maxPieces>25000||!Number.isInteger(maxChars)||maxChars<1||maxChars>1000000)throw Error('token_cache_capacity');
 const cache=new Map(),stats={hits:0,misses:0,fallbacks:0,evictions:0},escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');let chars=0;
 const pattern=typeof encoding.patStr==='string'?encoding.patStr:null,specials=encoding.specialTokens&&Object.keys(encoding.specialTokens);
 const original=text=>encoding.encode(text,'all').length;
 function count(text){if(typeof text!=='string'||text.length>200000)throw Error('token_count_input');if(!pattern||!specials){stats.fallbacks++;return original(text);}
  try{const special=specials.length?new RegExp(specials.map(escape).join('|'),'g'):null,regex=new RegExp(pattern,'ug');let start=0,total=0,covered=0;
   while(true){const next=special?.exec(text)??null,end=next?.index??text.length,part=text.slice(start,end);let local=0;
    for(const match of part.matchAll(regex)){const piece=match[0];local+=piece.length;let n=cache.get(piece);if(n!==undefined){stats.hits++;}else{
      // encode(piece) must not repartition a context-sensitive regex boundary.
      const pieces=[...piece.matchAll(new RegExp(pattern,'ug'))];if(pieces.length!==1||pieces[0][0]!==piece)throw Error('piece_boundary');
      n=encoding.encode(piece,[],[]).length;if(!Number.isInteger(n)||n<0)throw Error('piece_count');stats.misses++;
      if(piece.length<=maxChars){while(cache.size>=maxPieces||chars+piece.length>maxChars){const key=cache.keys().next().value;if(key===undefined)break;chars-=key.length;cache.delete(key);stats.evictions++;}cache.set(piece,n);chars+=piece.length;}
     }total+=n;
    }if(local!==part.length)throw Error('pattern_gap');covered+=local;if(!next)break;total++;covered+=next[0].length;start=next.index+next[0].length;
   }if(covered!==text.length)throw Error('coverage_gap');return total;
  }catch{stats.fallbacks++;return original(text);}
 }
 return {count,stats:()=>({...stats,size:cache.size,chars}),clear:()=>{cache.clear();chars=0;}};
}
