# heed — Ideas KILLER para destruir a la competencia

> Para Junior. Estrategia primero, código después. No estamos apurados con esto: son apuestas de
> foso (moat), algunas tardan, da igual. Cada idea dice: qué es, por qué la competencia NO puede
> copiarla, y qué del refactor de esta noche la habilita.

## El encuadre estratégico (la verdad incómoda y la oportunidad)

El mercado está **saturado** de transcriptores: Granola, Otter, Fathom, Fireflies, Meetily,
Hyprnote. Casi todos comparten 3 debilidades estructurales que NO pueden arreglar sin destruir su
propio modelo de negocio:

1. **Son nube.** Tu audio y el de tus reuniones sube a sus servidores. Eso los excluye de los
   usuarios de MAYOR valor: abogados, médicos, terapeutas, finanzas, ejecutivos, periodistas con
   fuentes, cualquiera bajo NDA/HIPAA/GDPR. No pueden volverse locales: su negocio ES tener tus datos.
2. **Necesitan un bot o una cuenta.** Fathom/Otter mandan un bot a tu Zoom; Granola necesita login.
   Fricción + señal social rara ("¿por qué hay un bot grabando?").
3. **Monetizan TUS datos.** Vos sos el producto. La diarización buena suele ser de pago (Meetily la
   tiene PRO-only).

**heed juega el juego opuesto, y ahí está el foso:** 100% local, Apple Neural Engine (Parakeet 115x,
FluidAudio diarización sin token), reconocimiento de voz cross-sesión (lo construimos ayer), cero
nube, cero cuenta, cero bot, open-source. La estrategia ganadora NO es "ser otro transcriptor mejor".
Es **redefinir la categoría**: de "transcriptor de reuniones" a **"memoria conversacional privada
que compone con el uso"**. Eso es lo que la competencia no puede seguir sin suicidarse.

Principio rector (48 Leyes / Blue Ocean): no compitas donde son fuertes (notas lindas en la nube).
**Crea un terreno nuevo donde su fortaleza es su debilidad** (la nube = imposibilidad de privacidad).

---

## TIER 1 — Fosos que COMPONEN con el uso (el verdadero endgame)

Estas son las que crean **switching cost creciente**: mientras más usás heed, más imposible es irte.
Es el único tipo de foso que un open-source local puede tener (no podés tener foso de red social,
pero SÍ de "tus datos viven acá y se vuelven más valiosos solos").

### 1. Grafo de identidad de voz personal ("quién, qué, cuándo")
Extender el voice-RAG cross-sesión (ya hecho) a un **grafo privado de relaciones**: cada voz
recurrente se vuelve un contacto con un dossier local — temas que tocaron, compromisos que asumió
("dijiste que enviabas X"), última vez que hablaron, sentimiento. Todo en `~/.heed-app`, cero nube.
- **Por qué no lo pueden copiar:** un CRM en la nube con esta data sería una bomba de privacidad
  (grabar a terceros sin que suba a un server es justo lo que NO pueden ofrecer). heed lo hace
  porque NUNCA sale de tu máquina.
- **Lo habilita el refactor:** los `turns` ya son un event-log append-only con speaker; el voice-RAG
  ya da identidad estable. El grafo es un fold sobre esos eventos.

### 2. Búsqueda semántica sobre TODAS tus conversaciones, filtrable por voz
Embeddings locales (mismo ANE) sobre todo tu historial de transcripts. "¿Qué se comprometió Carlos
sobre el presupuesto?" → busca por significado, filtrado por la VOZ de Carlos (voice-RAG), fecha,
tema. Una memoria buscable de cada conversación que tuviste.
- **Por qué mata:** ningún competidor tiene búsqueda cross-reunión + cross-speaker LOCAL. Otter
  busca texto en la nube; nadie cruza "por persona reconocida por voz" en local.
- **Habilitado por:** voice-RAG + el pipeline determinista. Es el "Rewind/Limitless pero privado y
  por persona".

### 3. Re-procesamiento retroactivo (tu librería MEJORA sola con el tiempo)
Como el pipeline ahora es event-log (turns) + funciones puras + adapters de motor, heed puede
**re-procesar grabaciones viejas con modelos mejores** cuando salgan (re-diarizar, re-transcribir,
re-RAG) SIN re-grabar. Tu transcript de hace 6 meses se vuelve más preciso solo.
- **Por qué mata:** la nube te cobra por re-procesar (costo de cómputo = su margen). En local es
  gratis y automático. Es un foso de calidad que COMPONE: cada mejora de modelo sube TODO tu archivo.
- **Habilitado por:** la abstracción de motor (`engines.py` puerto/adapter) + funciones puras
  testeadas (RF-7) + tipos de contrato (RF-1). Esta noche dejé justo las costuras para esto.

---

## TIER 2 — Diferenciadores de producto que la nube NO puede igualar

### 4. Copiloto de reunión EN VIVO, on-device (Ollama + MCP)
Las notas ya usan Ollama local. Sumar un agente que DURANTE la reunión, en privado y sin costo de
API, te sopla: action items apenas se comprometen, "vos dijiste que mandabas X", preguntas sin
responder, contradicciones de hecho, "llevás 8 min hablando vos". Granola hace esto post-hoc y en la
nube; heed lo hace LIVE y PRIVADO.
- **Por qué mata:** un copiloto en vivo que escucha a TODOS los participantes es inviable en la nube
  por privacidad/latencia/costo. En local con ANE + Ollama es gratis e instantáneo.

### 5. Privacidad VERIFICABLE como producto (el wedge regulatorio)
No solo "somos locales" — **demostrarlo**: panel de actividad de red que prueba 0 egress, builds
reproducibles y firmados, un "modo auditoría" que un compliance officer puede revisar. Apuntar
explícito a abogados/médicos/terapeutas/finanzas — los usuarios que LEGALMENTE no pueden usar la nube.
- **Por qué mata:** es un foso REGULATORIO por arquitectura (HIPAA/GDPR by design). La competencia
  nube literalmente no puede entrar a ese mercado. Es un océano azul de alto valor y baja competencia.
- **Mensaje de marca (Cialdini/posicionamiento):** "El único que puede grabar a tu terapeuta/cliente/
  paciente sin romper la ley, porque NADA sale de tu máquina." Eso es un titular que se comparte solo.

### 6. Captura cero-fricción en todos lados
Hotkey global + barra de menú; auto-detección de cualquier app de reunión (ya tenés meeting-detector)
con captura de un toque; captura de conversaciones presenciales (solo mic). El "siempre listo" que
Granola/Otter no pueden por necesitar bot o pestaña.
- **Habilitado por:** SCK ya resuelto + meeting-detector ya existe. Es pulido de UX, no R&D.

### 7. heed como servidor MCP: "tu memoria de reuniones, consultable por tu IA"
Exponer tu memoria conversacional como servidor MCP para Claude Desktop / cualquier agente local.
"¿Qué decidimos con el equipo sobre el lanzamiento?" desde tu asistente, leyendo tu archivo LOCAL.
- **Por qué mata:** te vuelve infraestructura, no una app. Foso de desarrollador/ecosistema. Y es
  100% coherente con la ola MCP actual (Hyprnote ya coquetea con esto; vos lo hacés con voice-RAG,
  que ellos no tienen).

---

## TIER 3 — Apuestas grandes (tardan, pero redefinen la categoría)

### 8. Modo "ambiente" (passive personal log)
VAD on-device siempre encendido (bajo consumo) que SOLO transcribe cuando detecta conversación real,
construyendo tu bitácora personal pasivamente. Privacy-safe porque es 100% local.
- **El pitch:** "Rewind/Limitless, pero tu vida no vive en el server de una startup que puede ser
  hackeada o comprada." El escándalo recurrente de esas apps ES su nube; heed no lo tiene.

### 9. Sync multi-dispositivo SOLO por red local / iCloud privado
Tu librería de voces y transcripts se sincroniza entre TUS dispositivos por LAN/iCloud E2E, nunca por
un server de heed.
- **Por qué mata:** "multi-device sin nube de terceros" es algo que una empresa SaaS no quiere
  construir (rompe su lock-in). Para un open-source local es el movimiento natural.

### 10. El foso de datos que COMPONE (la tesis de unicornio)
Juntá 1+2+3+8: cada grabación mejora el voice-RAG, el grafo de relaciones, la búsqueda y el archivo
re-procesable. El switching cost crece con cada reunión. **La competencia nube es dueña de TUS datos;
heed convierte TUS datos en un activo local que solo vos controlás y que se revaloriza solo.** Ese es
el único foso defendible para un open-source — y es más fuerte que el de ellos, porque el de ellos
depende de retenerte rehén, y el tuyo depende de darte algo que se vuelve tuyo.

---

## Secuenciación recomendada (no apurada, pero con orden de palanca)

1. **Ahora / pre-lanzamiento:** terminá el voice-RAG real-time (enroll en Sortformer) + captura
   cero-fricción (#6). Es lo que ya tenés casi y cierra la demo "mágica".
2. **Post-lanzamiento inmediato (la cuña de mercado):** privacidad verificable (#5) como MENSAJE de
   marca y wedge hacia los profesionales bajo NDA. Es marketing + un poco de UI, alto retorno.
3. **El foso (3-6 meses):** búsqueda semántica local (#2) + grafo de identidad (#1) + re-procesamiento
   (#3). Acá nace el "no me puedo ir de heed".
4. **El ecosistema:** servidor MCP (#7) + copiloto en vivo (#4).
5. **La apuesta de unicornio:** modo ambiente (#8) + sync local (#9) = la categoría nueva.

## Por qué el refactor de anoche importa para esto

Ninguna de estas ideas se construye rápido sobre dos God files sin tests con estado mutable global.
Esta noche dejé: **contratos tipados** (los eventos/estados ya no driftean), **funciones puras
testeadas** (la lógica de diarización/voz está pinneada), **adapters de motor** (cambiar/mejorar
modelos sin tocar el pipeline = idea #3), **event-log de turns** (base del grafo y la búsqueda =
ideas #1, #2), y **supervisión de procesos** (para que el modo ambiente #8 corra 24/7 sin dejar
huérfanos). El refactor no fue cosmético: fue **poner los cimientos del foso**.
