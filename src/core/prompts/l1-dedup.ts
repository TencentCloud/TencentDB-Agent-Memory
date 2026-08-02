/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `Ты — детектор конфликтов памяти. Пакетно сравниваешь несколько НОВЫХ ВОСПОМИНАНИЙ с ЕДИНЫМ ПУЛОМ КАНДИДАТОВ — уже существующими воспоминаниями, и решаешь по каждому, что делать.

**Язык вывода**: \`merged_content\` **обязательно пишется на русском языке** (пользователь русскоязычный), даже если старые кандидаты в пуле на другом языке. Имена полей JSON, значения enum, record_id и ISO-временные метки остаются на английском.

## Ключевые правила

- **Кросс-тип слияние**: воспоминания разных типов (persona / episodic / instruction), если они семантически описывают один факт/событие, **можно слить**.
- **Слияние один-ко-многим**: одно новое воспоминание может одновременно заменить/слить **несколько** существующих воспоминаний из пула кандидатов (указывается через массив target_ids).
- После слияния ты обязан определить лучший type для нового воспоминания (merged_type).

## Логика решения

1. **Определи характер памяти**:
   - **Состояние** (persona/instruction): предпочтения, черты, долгосрочные установки, относительно стабильные факты, правила поведения
   - **Событие** (episodic): разовое переживание, объективная запись с привязкой ко времени; рекомендуется объединять причину и следствие одного события

2. **Определи, один ли это факт/событие**: субъект совпадает, тема совпадает, время близко, scene_name похож

3. **Выбери действие**:
   - "store": считается новой информацией — добавить текущее воспоминание.
   - "skip": существующее воспоминание лучше, новое не даёт прироста или размыто — игнорировать текущее воспоминание.
   - "update": тот же факт/событие, новое воспоминание лучше по содержанию или времени (конкретнее, позже или исправляет ошибку) — перекрыть старое новым, сохранив детали старого, которые всё ещё верны.
   - "merge": тот же факт или тот же процесс эволюции, несколько воспоминаний дополняют друг друга и не противоречат — слить в одно более полное, без лишней избыточности.

4. **Склонности по стратегии**:
   - Состояние: несколько описаний одного предпочтения/черты → склоняйся к merge; нет прироста → skip; явное обновление → update
   - Событие: причина и следствие одного события, разные стадии → склоняйся к merge в одно полное повествование; полностью идентичное → skip
   - **Продолжение одной задачи**: несколько episodic описывают последовательные стадии одной задачи ("пользователь продолжает разработку X", "задача X дошла до итерации N") при совпадении субъекта/темы/проекта → склоняйся к merge в одно полное повествование (со всеми временными метками) или update до последнего состояния; **никогда не store повторное описание задачи**
   - Пример кросс-типа: episodic "пользователь начал подкаст в 2018" + persona "у пользователя есть опыт ведения подкастов" → можно слить в одну persona или episodic (зависит от фокуса информации)

5. **Обработка временных меток**:
   - При merge/update merged_timestamps должен содержать **объединение временных меток всех релевантных воспоминаний** (дедуп + сортировка)
   - Так сохраняется полная временная линия события

## Формат вывода

Строго выведи JSON-массив, каждый элемент — решение по одному новому воспоминанию. Ничего больше не выводи:

[
  {
    "record_id": "record_id нового воспоминания",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id удаляемого кандидата 1", "record_id 2"],
    "merged_content": "содержимое памяти после слияния/обновления (обязательно при merge/update)",
    "merged_type": "лучший type после слияния: persona|episodic|instruction (обязательно при merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["массив временных меток после слияния: объединение всех старых и новых (обязательно при merge/update)"]
  }
]

Пояснение полей:
- target_ids: ID **массив** старых воспоминаний для удаления/замены (можно 1 или несколько). При store/skip опускается или пустой.
- merged_content: финальный текст памяти при merge/update. При store/skip опускается.
- merged_type: тип, к которому относится память после merge/update. Определяется по сути объединённого содержимого.
- merged_priority: новый приоритет после merge/update (целое 0-100, обязательно при merge/update). После слияния информация полнее и определённее, обычно приоритет стоит **повысить по ситуации** (например, два воспоминания priority 70 после слияния можно поднять до 80). Ориентир: 80-100 (ключевая черта/важное событие), 60-79 (обычное предпочтение/рядовая активность), <60 (второстепенная информация).
- merged_timestamps: массив временных меток после слияния. Собери метки нового воспоминания + всех сливаемых старых, дедуп + сортировка.`;

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
  /**
   * Deterministic near-dup target (record_id of the top-1 candidate with
   * score >= NEAR_DUP_SCORE and same type). When set, the memory is forced
   * to "update" against this target without LLM judgment.
   */
  nearDupTarget?: string;
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Единый пул кандидатов\n\n(пусто — существующих воспоминаний нет, все новые памяти сразу store)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Единый пул кандидатов (всего ${poolList.length} существующих воспоминаний)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (похожих кандидатов нет — сразу store)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### Новое воспоминание № ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[ID связанных кандидатов]${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Язык вывода**: \`merged_content\` **обязательно пишется на русском языке** (пользователь русскоязычный), даже если старые кандидаты на другом языке.

${poolSection}

${"═".repeat(50)}

## Новые воспоминания для решения (всего ${matches.length})

${newMemoriesText}

Решай по каждому воспоминанию по очереди и выводи массив решений JSON. Если у какого-то нового воспоминания список кандидатов пуст — для него выводи action=store.`;
}
