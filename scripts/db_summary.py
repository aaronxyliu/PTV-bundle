#!/usr/bin/env python3

import argparse
import os

import pymysql
from dotenv import load_dotenv


def parse_args():
    parser = argparse.ArgumentParser(description="Summarize paired PTV stage-2 MySQL results.")
    parser.add_argument("--database", default=os.getenv("DB_DATABASE", "debundle_stage2"))
    parser.add_argument("--table-prefix", default="ptv_pair_puppeteer")
    return parser.parse_args()


def connect_mysql(database):
    load_dotenv()
    return pymysql.connect(
        host=os.getenv("DB_HOST"),
        user=os.getenv("DB_USERNAME"),
        password=os.getenv("DB_PASSWORD"),
        database=database,
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )


def main():
    args = parse_args()
    conn = connect_mysql(args.database)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT
                  COUNT(*) AS rows_count,
                  SUM(baseline_library_count) AS baseline_total,
                  SUM(instrumented_library_count) AS instrumented_total,
                  SUM(new_library_count) AS new_total,
                  SUM(baseline_status = 'ok') AS baseline_ok,
                  SUM(instrumented_status = 'ok') AS instrumented_ok
                FROM `{args.table_prefix}_runs`
                """
            )
            print(cursor.fetchone())
    finally:
        conn.close()


if __name__ == "__main__":
    main()
