#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path

import pymysql
from dotenv import load_dotenv


def parse_args():
    parser = argparse.ArgumentParser(description="Import paired PTV stage-2 JSONL results into MySQL.")
    parser.add_argument("--input", default="stage2-ptv-pair-puppeteer-results.jsonl")
    parser.add_argument("--database", default=os.getenv("DB_DATABASE", "debundle_stage2"))
    parser.add_argument("--table-prefix", default="ptv_pair_puppeteer")
    return parser.parse_args()


def connect_mysql(database):
    load_dotenv()
    host = os.getenv("DB_HOST")
    user = os.getenv("DB_USERNAME")
    password = os.getenv("DB_PASSWORD")
    if not host or not user:
        raise RuntimeError("DB_HOST and DB_USERNAME must be set in .env")

    root_conn = pymysql.connect(host=host, user=user, password=password, autocommit=True)
    with root_conn.cursor() as cursor:
        cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{database}` DEFAULT CHARACTER SET utf8mb4")
    root_conn.close()
    return pymysql.connect(host=host, user=user, password=password, database=database, autocommit=True)


def ensure_tables(conn, prefix):
    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS `{prefix}_runs` (
              `id` BIGINT NOT NULL AUTO_INCREMENT,
              `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              `crawl_started_at` VARCHAR(64),
              `crawl_ended_at` VARCHAR(64),
              `rank` INT,
              `domain` VARCHAR(255),
              `url` TEXT,
              `baseline_final_url` TEXT,
              `instrumented_final_url` TEXT,
              `baseline_status` VARCHAR(64),
              `instrumented_status` VARCHAR(64),
              `baseline_navigation_status` VARCHAR(64),
              `instrumented_navigation_status` VARCHAR(64),
              `baseline_detect_time_ms` INT,
              `instrumented_detect_time_ms` INT,
              `baseline_detected_json` JSON,
              `instrumented_detected_json` JSON,
              `baseline_library_count` INT,
              `instrumented_library_count` INT,
              `new_library_count` INT,
              `new_libraries_json` JSON,
              `scripts_seen` INT,
              `scripts_instrumented` INT,
              `scripts_failed` INT,
              `scripts_parse_failed` INT,
              `scripts_errored` INT,
              `page_state_json` JSON,
              `baseline_error` TEXT,
              `instrumented_error` TEXT,
              PRIMARY KEY (`id`)
            )
            """
        )
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS `{prefix}_script_logs` (
              `id` BIGINT NOT NULL AUTO_INCREMENT,
              `run_id` BIGINT,
              `script_url` TEXT,
              `status` VARCHAR(64),
              `changed` BOOLEAN,
              `webpack_pattern` VARCHAR(255),
              `source_type` VARCHAR(32),
              `parse_error` TEXT,
              `warnings_json` JSON,
              `error` TEXT,
              PRIMARY KEY (`id`)
            )
            """
        )


def insert_result(conn, prefix, record):
    baseline = record.get("baseline") or {}
    instrumented = record.get("instrumented") or {}
    instrumentation = record.get("instrumentation") or {}
    baseline_detected = baseline.get("detected") or []
    instrumented_detected = instrumented.get("detected") or []
    new_libraries = record.get("new_libraries") or []

    with conn.cursor() as cursor:
        cursor.execute(
            f"""
            INSERT INTO `{prefix}_runs` (
              `crawl_started_at`, `crawl_ended_at`, `rank`, `domain`, `url`,
              `baseline_final_url`, `instrumented_final_url`,
              `baseline_status`, `instrumented_status`,
              `baseline_navigation_status`, `instrumented_navigation_status`,
              `baseline_detect_time_ms`, `instrumented_detect_time_ms`,
              `baseline_detected_json`, `instrumented_detected_json`,
              `baseline_library_count`, `instrumented_library_count`,
              `new_library_count`, `new_libraries_json`,
              `scripts_seen`, `scripts_instrumented`, `scripts_failed`,
              `scripts_parse_failed`, `scripts_errored`, `page_state_json`,
              `baseline_error`, `instrumented_error`
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                record.get("crawl_started_at", ""),
                record.get("crawl_ended_at", ""),
                record.get("rank"),
                record.get("domain", ""),
                record.get("url", ""),
                baseline.get("final_url", ""),
                instrumented.get("final_url", ""),
                baseline.get("status", ""),
                instrumented.get("status", ""),
                baseline.get("navigation_status", ""),
                instrumented.get("navigation_status", ""),
                baseline.get("detect_time_ms", 0),
                instrumented.get("detect_time_ms", 0),
                json.dumps(baseline_detected, ensure_ascii=False),
                json.dumps(instrumented_detected, ensure_ascii=False),
                len(baseline_detected),
                len(instrumented_detected),
                len(new_libraries),
                json.dumps(new_libraries, ensure_ascii=False),
                instrumentation.get("scripts_seen", 0),
                instrumentation.get("scripts_instrumented", 0),
                instrumentation.get("scripts_failed", 0),
                instrumentation.get("scripts_parse_failed", 0),
                instrumentation.get("scripts_errored", 0),
                json.dumps(record.get("page_state") or {}, ensure_ascii=False),
                baseline.get("error", ""),
                instrumented.get("error", ""),
            ),
        )
        run_id = cursor.lastrowid

        for script in instrumentation.get("scripts") or []:
            cursor.execute(
                f"""
                INSERT INTO `{prefix}_script_logs` (
                  `run_id`, `script_url`, `status`, `changed`, `webpack_pattern`,
                  `source_type`, `parse_error`, `warnings_json`, `error`
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_id,
                    script.get("url", ""),
                    str(script.get("status", "")),
                    1 if script.get("changed") else 0,
                    script.get("webpackPattern", ""),
                    script.get("sourceType", ""),
                    script.get("parseError", ""),
                    json.dumps(script.get("warnings") or [], ensure_ascii=False),
                    script.get("error", ""),
                ),
            )

    return run_id


def main():
    args = parse_args()
    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(input_path)

    conn = connect_mysql(args.database)
    try:
        ensure_tables(conn, args.table_prefix)
        count = 0
        for line in input_path.read_text().splitlines():
            if not line.strip():
                continue
            insert_result(conn, args.table_prefix, json.loads(line))
            count += 1
        print(f"Imported {count} paired records into {args.database}.{args.table_prefix}_runs")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
