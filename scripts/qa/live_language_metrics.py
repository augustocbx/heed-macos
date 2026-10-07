"""Conservative public-fixture scores. Language preservation uses lexical anchors,
never the forced ASR language field, and still requires human translation review.
WER: NFC/casefold, punctuation removed, whitespace split. CER uses the same NFC
comparison string, counting Unicode code points including internal spaces/accents.
These comparison copies never replace recognized or persisted text.
"""
import unicodedata


def normalized(text):
    value=unicodedata.normalize('NFC',text).casefold()
    return ' '.join(''.join(' ' if unicodedata.category(char).startswith('P') else char for char in value).split())


def alignment(reference,hypothesis):
    rows=len(reference);cols=len(hypothesis)
    cost=[[0]*(cols+1) for _ in range(rows+1)]
    for i in range(rows+1):cost[i][cols]=rows-i
    for j in range(cols+1):cost[rows][j]=cols-j
    for i in range(rows-1,-1,-1):
        for j in range(cols-1,-1,-1):cost[i][j]=min(cost[i+1][j]+1,cost[i][j+1]+1,cost[i+1][j+1]+(reference[i]!=hypothesis[j]))
    result=[];i=0;j=0
    while i<rows or j<cols:
        if i<rows and j<cols and cost[i][j]==cost[i+1][j+1]+(reference[i]!=hypothesis[j]):
            result.append((i,j,'equal' if reference[i]==hypothesis[j] else 'substitution'));i+=1;j+=1
        elif i<rows and cost[i][j]==cost[i+1][j]+1:result.append((i,None,'deletion'));i+=1
        else:result.append((None,j,'insertion'));j+=1
    return result


def phrase_count(tokens,phrase):
    words=normalized(phrase).split()
    return sum(tokens[i:i+len(words)]==words for i in range(len(tokens)-len(words)+1)) if words else 0


def error_metrics(reference,hypothesis):
    ref=normalized(reference);hyp=normalized(hypothesis)
    ops=alignment(ref.split(),hyp.split());chars=alignment(list(ref),list(hyp))
    result={key:sum(op[2]==operation for op in ops) for key,operation in [('substitutions','substitution'),('deletions','deletion'),('insertions','insertion')]}
    errors=sum(result.values());result.update(referenceWords=len(ref.split()),predictionWords=len(hyp.split()),wer=errors/len(ref.split()) if ref else (0 if not hyp else None),cer=sum(op[2]!='equal' for op in chars)/len(ref) if ref else (0 if not hyp else None))
    return result


def score_fixture(reference,prediction,annotated_spans):
    segments=prediction if isinstance(prediction,list) else []
    text=' '.join(segment.get('text','') for segment in segments) if segments else (prediction if isinstance(prediction,str) else '')
    tokens=normalized(text).split();ref_tokens=normalized(reference).split();ops=alignment(ref_tokens,tokens)
    result=error_metrics(reference,text);result['silenceHallucination']=not normalized(reference) and bool(normalized(text));result['manualLanguageReviewRequired']=True
    # Map reference words to explicit span boundaries, then allocate aligned insertions
    # to the neighboring original span. Annotation text must match the reference order.
    word_languages=[];cursor=0
    for span in annotated_spans:
        words=normalized(span['text']).split()
        if ref_tokens[cursor:cursor+len(words)]!=words:raise ValueError('Span text does not match ordered fixture reference')
        word_languages.extend([span['language']]*len(words));cursor+=len(words)
    if annotated_spans and cursor!=len(ref_tokens):raise ValueError('Spans must cover the complete reference')
    refs={};hyps={};anchor=0
    for index,word in enumerate(ref_tokens):
        if word_languages:refs.setdefault(word_languages[index],[]).append(word)
    for ri,hi,_ in ops:
        if ri is not None:anchor=ri
        if hi is not None and word_languages:hyps.setdefault(word_languages[min(anchor,len(word_languages)-1)],[]).append(tokens[hi])
    result['perLanguage']={language:error_metrics(' '.join(words),' '.join(hyps.get(language,[]))) for language,words in refs.items()}
    missed=duplicated=translated=preserved=0;details=[];timing=[]
    for span in annotated_spans:
        words=normalized(span['text']).split();count=phrase_count(tokens,span['text'])
        matched=sum(word in tokens for word in words)
        is_translated=any(phrase_count(tokens,alternative) for alternative in span.get('translatedAlternatives',[]))
        anchors=span.get('languageAnchors',[])
        language_preserved=bool(anchors) and all(phrase_count(tokens,anchor) for anchor in anchors) and not is_translated
        missed+=int(matched==0);duplicated+=int(count>1);translated+=int(is_translated);preserved+=int(language_preserved)
        details.append({'id':span['id'],'matchedReferenceWords':matched,'referenceWords':len(words),'exactOccurrences':count,'lexicalLanguagePreserved':language_preserved,'knownTranslationDetected':is_translated})
        candidates=[segment for segment in segments if phrase_count(normalized(segment.get('text','')).split(),span['text']) and all(isinstance(segment.get(key),(int,float)) and isinstance(span.get(key),(int,float)) for key in ['start','end'])]
        if candidates:
            segment=min(candidates,key=lambda value:abs(value['start']-span['start']))
            timing.extend([abs(segment['start']-span['start']),abs(segment['end']-span['end'])])
    result['spans']={'count':len(annotated_spans),'missed':missed,'duplicated':duplicated,'translated':translated,'languagePreserved':preserved,'languagePreservedFraction':preserved/len(annotated_spans) if annotated_spans else None,'details':details}
    for kind in ['names','terms']:
        phrases=[phrase for span in annotated_spans for phrase in span.get(kind,[])]
        result[kind]={'count':len(phrases),'preserved':sum(bool(phrase_count(tokens,phrase)) for phrase in phrases)}
    result['timestamps']={'matchedBoundaries':len(timing),'meanAbsoluteErrorSeconds':sum(timing)/len(timing) if timing else None,'maxAbsoluteErrorSeconds':max(timing) if timing else None}
    return result
