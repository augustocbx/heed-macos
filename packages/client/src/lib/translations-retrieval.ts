/** Retrieval status copy; authored meeting content is never translated. */
export const RETRIEVAL_TRANSLATIONS: Record<
  string,
  { "pt-BR": string; fr: string; de: string }
> = Object.fromEntries(
  [
    [
      "Retrieval coverage",
      "Cobertura da recuperação",
      "Couverture de la recherche",
      "Suchabdeckung",
    ],
    ["unknown", "desconhecido", "inconnu", "unbekannt"],
    [
      "Meetings: {selected} selected · {indexed} indexed · {searched} searched · {retrieved} retrieved · {supplied} supplied · {cited} cited.",
      "Reuniões: {selected} selecionadas · {indexed} indexadas · {searched} pesquisadas · {retrieved} recuperadas · {supplied} fornecidas · {cited} citadas.",
      "Réunions : {selected} sélectionnées · {indexed} indexées · {searched} recherchées · {retrieved} trouvées · {supplied} fournies · {cited} citées.",
      "Besprechungen: {selected} ausgewählt · {indexed} indexiert · {searched} durchsucht · {retrieved} gefunden · {supplied} bereitgestellt · {cited} zitiert.",
    ],
    [
      "Transcript excerpts: {selected} selected · {indexed} indexed · {searched} searched · {matched} matched · {retrieved} retrieved · {supplied} supplied · {cited} cited.",
      "Trechos da transcrição: {selected} selecionados · {indexed} indexados · {searched} pesquisados · {matched} correspondentes · {retrieved} recuperados · {supplied} fornecidos · {cited} citados.",
      "Extraits de transcription : {selected} sélectionnés · {indexed} indexés · {searched} recherchés · {matched} correspondants · {retrieved} trouvés · {supplied} fournis · {cited} cités.",
      "Transkriptauszüge: {selected} ausgewählt · {indexed} indexiert · {searched} durchsucht · {matched} passend · {retrieved} gefunden · {supplied} bereitgestellt · {cited} zitiert.",
    ],
    [
      "Retrieval strategy: bounded fallback.",
      "Estratégia de recuperação: alternativa limitada.",
      "Stratégie de recherche : solution de repli limitée.",
      "Suchstrategie: begrenzte Ausweichsuche.",
    ],
    [
      "Retrieval strategy: lexical lookup.",
      "Estratégia de recuperação: busca lexical.",
      "Stratégie de recherche : recherche lexicale.",
      "Suchstrategie: lexikalische Suche.",
    ],
    [
      "Answers use only supplied excerpts and meeting details. Lexical coverage does not establish whole-transcript absence.",
      "As respostas usam somente os trechos e dados das reuniões fornecidos. A cobertura lexical não comprova a ausência de um assunto na transcrição inteira.",
      "Les réponses utilisent uniquement les extraits et informations de réunion fournis. La couverture lexicale ne prouve pas l’absence d’un sujet dans toute la transcription.",
      "Antworten verwenden nur bereitgestellte Auszüge und Besprechungsdaten. Lexikalische Abdeckung beweist nicht, dass ein Thema im gesamten Transkript fehlt.",
    ],
    [
      "Some selected transcripts are not indexed yet.",
      "Algumas transcrições selecionadas ainda não estão indexadas.",
      "Certaines transcriptions sélectionnées ne sont pas encore indexées.",
      "Einige ausgewählte Transkripte sind noch nicht indexiert.",
    ],
    [
      "Some selected transcripts changed and need reindexing.",
      "Algumas transcrições selecionadas mudaram e precisam ser reindexadas.",
      "Certaines transcriptions sélectionnées ont changé et doivent être réindexées.",
      "Einige ausgewählte Transkripte wurden geändert und müssen neu indexiert werden.",
    ],
    [
      "The index reached its storage or evidence limit. Some selected excerpts are not indexed.",
      "O índice atingiu o limite de armazenamento ou de evidências. Alguns trechos selecionados não estão indexados.",
      "L’index a atteint sa limite de stockage ou de preuves. Certains extraits sélectionnés ne sont pas indexés.",
      "Der Index hat seine Speicher- oder Beleggrenze erreicht. Einige ausgewählte Auszüge sind nicht indexiert.",
    ],
    [
      "Fallback examined only a bounded part of the selected transcripts.",
      "A busca alternativa examinou somente uma parte limitada das transcrições selecionadas.",
      "La recherche de repli a examiné seulement une partie limitée des transcriptions sélectionnées.",
      "Die Ausweichsuche hat nur einen begrenzten Teil der ausgewählten Transkripte geprüft.",
    ],
    [
      "Lexical lookup stopped before completion. Some matches may be missing.",
      "A busca lexical parou antes de terminar. Algumas correspondências podem estar ausentes.",
      "La recherche lexicale s’est arrêtée avant la fin. Certaines correspondances peuvent manquer.",
      "Die lexikalische Suche wurde vorzeitig beendet. Einige Treffer könnten fehlen.",
    ],
    [
      "The model context budget limited the supplied input. Ask a narrower question.",
      "O limite de contexto do modelo restringiu a entrada fornecida. Faça uma pergunta mais específica.",
      "Le budget de contexte du modèle a limité les données fournies. Posez une question plus précise.",
      "Das Kontextbudget des Modells hat die bereitgestellten Eingaben begrenzt. Stellen Sie eine genauere Frage.",
    ],
    [
      "Answer generation reached its request limit. Ask a narrower question.",
      "A geração da resposta atingiu o limite de solicitações. Faça uma pergunta mais específica.",
      "La génération de réponse a atteint sa limite de requêtes. Posez une question plus précise.",
      "Die Antworterstellung hat ihre Anfragegrenze erreicht. Stellen Sie eine genauere Frage.",
    ],
    [
      "Retrieval coverage is limited. Ask a narrower question.",
      "A cobertura da recuperação é limitada. Faça uma pergunta mais específica.",
      "La couverture de recherche est limitée. Posez une question plus précise.",
      "Die Suchabdeckung ist begrenzt. Stellen Sie eine genauere Frage.",
    ],
    [
      "No lexical matches found. This does not establish that the topic is absent from the selected transcripts.",
      "Nenhuma correspondência lexical foi encontrada. Isso não comprova que o assunto esteja ausente das transcrições selecionadas.",
      "Aucune correspondance lexicale trouvée. Cela ne prouve pas que le sujet soit absent des transcriptions sélectionnées.",
      "Keine lexikalischen Treffer gefunden. Dies beweist nicht, dass das Thema in den ausgewählten Transkripten fehlt.",
    ],
    [
      "No supporting evidence found in the supplied excerpts.",
      "Nenhuma evidência de apoio foi encontrada nos trechos fornecidos.",
      "Aucune preuve à l’appui trouvée dans les extraits fournis.",
      "Keine stützenden Belege in den bereitgestellten Auszügen gefunden.",
    ],
    [
      "Waiting for the local transcript catalog to become ready.",
      "Aguardando o catálogo local de transcrições ficar pronto.",
      "En attente de la disponibilité du catalogue local de transcriptions.",
      "Wartet, bis der lokale Transkriptkatalog bereit ist.",
    ],
    [
      "Local transcripts are still being discovered. Wait, then refresh chat.",
      "As transcrições locais ainda estão sendo descobertas. Aguarde e atualize a conversa.",
      "La découverte des transcriptions locales est en cours. Patientez, puis actualisez la discussion.",
      "Lokale Transkripte werden noch erfasst. Warten Sie und aktualisieren Sie dann den Chat.",
    ],
    [
      "The local transcript catalog reached its capacity. Reduce the stored meeting collection and refresh chat.",
      "O catálogo local de transcrições atingiu sua capacidade. Reduza a coleção de reuniões armazenadas e atualize a conversa.",
      "Le catalogue local de transcriptions a atteint sa capacité. Réduisez la collection de réunions enregistrées et actualisez la discussion.",
      "Der lokale Transkriptkatalog hat seine Kapazität erreicht. Verkleinern Sie die gespeicherte Besprechungssammlung und aktualisieren Sie den Chat.",
    ],
    [
      "Local transcript retrieval is unavailable. Refresh chat and retry.",
      "A recuperação local de transcrições está indisponível. Atualize a conversa e tente novamente.",
      "La recherche locale de transcriptions est indisponible. Actualisez la discussion et réessayez.",
      "Die lokale Transkriptsuche ist nicht verfügbar. Aktualisieren Sie den Chat und versuchen Sie es erneut.",
    ],
    [
      "This question or its required evidence exceeds the local model input budget. Ask a shorter or narrower question.",
      "Esta pergunta ou suas evidências necessárias excedem o limite de entrada do modelo local. Faça uma pergunta mais curta ou específica.",
      "Cette question ou les preuves requises dépassent le budget d’entrée du modèle local. Posez une question plus courte ou précise.",
      "Diese Frage oder die benötigten Belege überschreiten das Eingabebudget des lokalen Modells. Stellen Sie eine kürzere oder genauere Frage.",
    ],
  ].map(([en, pt, fr, de]) => [en, { "pt-BR": pt, fr, de }]),
);
