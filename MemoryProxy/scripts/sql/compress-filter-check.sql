-- compress_filter_logs 数据体检。用法：
--   npx tsx scripts/ck-sql.ts scripts/sql/compress-filter-check.sql --continue
-- 第 4、5 段每一列都是「违反约束的行数」，正常应全为 0。

-- 1. 总量与时间范围
SELECT event_type, count() AS rows, min(timestamp) AS first, max(timestamp) AS last,
       uniqExact(request_id) AS requests, uniqExact(session_key) AS sessions, groupUniqArray(host) AS hosts
FROM compress_filter_logs
GROUP BY event_type
ORDER BY event_type;

-- 2. 公共字段缺失（每列为空值的行数）
SELECT event_type, count() AS rows,
       countIf(request_id = '') AS no_request_id,
       countIf(upstream_request_id = '') AS no_upstream_request_id,
       countIf(space_id = '') AS no_space_id,
       countIf(model_id = '') AS no_model_id,
       countIf(base_url = '') AS no_base_url,
       countIf(session_key = '') AS no_session_key,
       countIf(turn_seq = 0) AS turn_seq_0,
       groupUniqArray(protocol) AS protocols,
       groupUniqArray(base_url) AS base_urls
FROM compress_filter_logs
GROUP BY event_type
ORDER BY event_type;

-- 3. request / response 配对（按 request_id）
SELECT
  countIf(has_req AND has_resp) AS paired,
  countIf(has_req AND NOT has_resp) AS request_only,
  countIf(NOT has_req AND has_resp) AS response_only,
  countIf(n_req > 1 OR n_resp > 1) AS duplicated
FROM (
  SELECT request_id,
         countIf(event_type = 'request') AS n_req, countIf(event_type = 'response') AS n_resp,
         n_req > 0 AS has_req, n_resp > 0 AS has_resp
  FROM compress_filter_logs
  WHERE request_id != ''
  GROUP BY request_id
);

-- 4. request 行内部一致性
SELECT count() AS rows,
  countIf(units != skipped + compressed_fresh + compressed_cached + remote_failed) AS units_mismatch,
  countIf(skipped != skipped_fresh + skipped_cached) AS skipped_mismatch,
  countIf(remote_calls > units) AS remote_gt_units,
  countIf(not_sent != units - remote_calls) AS not_sent_mismatch,
  countIf(arraySum(mapValues(skip_reasons)) != skipped_fresh) AS reasons_vs_fresh,
  countIf(arraySum(mapValues(skip_reasons_cached)) != skipped_cached) AS cached_reasons_vs_cached,
  countIf(skip_no_cfq + skip_embedded_image + skip_sql_content + skip_below_min_length + skip_content_type
        + skip_code + skip_source_filter + skip_keep_full + skip_scene + skip_semaphore_overflow
        + skip_server_kept_original + skip_not_shorter + skip_server_invalid + skip_remote_error
        + skip_malformed + skip_other != skipped_fresh) AS flat_cols_vs_fresh,
  countIf(skip_no_cfq != skip_reasons['no_cfq']) AS no_cfq_col_vs_map,
  countIf(arraySum(mapValues(no_cfq_tools)) != skip_no_cfq) AS no_cfq_tools_vs_col,
  countIf(backfill_hits > backfill_targets OR backfill_with_cfq > backfill_hits) AS backfill_order,
  countIf(echo_hit > echo_total) AS echo_order,
  countIf(comp_tokens > orig_tokens) AS comp_gt_orig
FROM compress_filter_logs
WHERE event_type = 'request';

-- 5. response 行内部一致性
SELECT count() AS rows,
  countIf(cfq_generated > cfq_expected) AS generated_gt_expected,
  countIf(cfq_self_filled + fallback_generated != cfq_generated) AS self_plus_fallback_vs_generated,
  countIf(cfq_missing != cfq_expected - cfq_self_filled) AS missing_mismatch,
  countIf(fallback_generated > 0 AND fallback_ran = 0) AS fallback_gen_without_run,
  countIf(cfq_generated < cfq_expected AND missing_reason = '' AND settle_status = 'settled') AS gap_without_reason,
  countIf(settle_status = 'settled' AND settle_ms > 9000) AS settle_over_budget,
  countIf(redis_failed > 0 AND redis_error = '' AND redis_timed_out = 0) AS failed_without_error
FROM compress_filter_logs
WHERE event_type = 'response';

-- 6. 过滤原因分布（本轮新判 / 缓存回放）
SELECT 'fresh' AS kind, sumMap(skip_reasons) AS reasons FROM compress_filter_logs WHERE event_type = 'request'
UNION ALL
SELECT 'cached' AS kind, sumMap(skip_reasons_cached) AS reasons FROM compress_filter_logs WHERE event_type = 'request';

-- 7. request 汇总
SELECT count() AS requests, sum(units) AS units, sum(tool_results) AS tool_results,
       sum(remote_calls) AS sent, sum(not_sent) AS not_sent, sum(remote_failed) AS remote_failed,
       sum(compressed_fresh) AS compressed_fresh, sum(skip_no_cfq) AS no_cfq,
       sum(backfill_targets) AS bf_targets, sum(backfill_with_cfq) AS bf_with_cfq, sum(backfill_missed) AS bf_missed,
       round(sum(echo_hit) / nullIf(sum(echo_total), 0), 3) AS echo_rate,
       round(1 - sum(comp_tokens) / nullIf(sum(orig_tokens), 0), 3) AS token_saving,
       quantiles(0.5, 0.9, 0.99)(prepare_ms) AS prepare_ms_p50_90_99
FROM compress_filter_logs
WHERE event_type = 'request';

-- 8. response 汇总
SELECT settle_status, count() AS rows, sum(tool_calls) AS tool_calls,
       sum(cfq_expected) AS expected, sum(cfq_generated) AS generated, sum(cfq_self_filled) AS self_filled,
       sum(fallback_generated) AS fallback_generated, sum(redis_persisted) AS persisted, sum(redis_failed) AS redis_failed,
       groupUniqArray(missing_reason) AS missing_reasons,
       quantiles(0.5, 0.9, 0.99)(settle_ms) AS settle_ms_p50_90_99
FROM compress_filter_logs
WHERE event_type = 'response'
GROUP BY settle_status;

-- 9. 最近 10 行
SELECT timestamp, event_type, request_id, upstream_request_id, space_id, model_id, base_url, turn_seq,
       units, remote_calls, not_sent, skipped_fresh, skip_no_cfq, settle_status, cfq_expected, cfq_generated, settle_ms
FROM compress_filter_logs
ORDER BY timestamp DESC
LIMIT 10;
