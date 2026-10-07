from live_language_metrics import error_metrics,normalized,phrase_count

def score(reference,prediction,terms):
 tokens=normalized(prediction).split();refs=normalized(reference).split()
 spoken=[term for term in terms if phrase_count(refs,term)]
 return {**error_metrics(reference,prediction),'spokenTerms':len(spoken),'correctTerms':sum(bool(phrase_count(tokens,term)) for term in spoken),
         'falseInsertions':sum(max(0,phrase_count(tokens,term)-phrase_count(refs,term)) for term in terms),
         'unrelatedSpeech':bool(reference.strip()) and not spoken,'silenceHallucination':not reference.strip() and bool(prediction.strip())}
