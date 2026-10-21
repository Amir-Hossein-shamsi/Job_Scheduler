package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
)

// This fake reproduces pgx's single-connection restriction: writes fail while
// the SELECT result set remains open, including when only one row is due.
type dueRows struct {
	pgx.Rows
	items  []dueSchedule
	index  int
	closed bool
}

func (r *dueRows) Next() bool {
	r.index++
	if r.index >= len(r.items) {
		r.closed = true
		return false
	}
	return true
}
func (r *dueRows) Close()     { r.closed = true }
func (r *dueRows) Err() error { return nil }
func (r *dueRows) Scan(dest ...any) error {
	s := r.items[r.index]
	*dest[0].(*string) = s.ID
	*dest[1].(*string) = s.JobID
	*dest[2].(*string) = s.Type
	*dest[3].(**time.Time) = s.RunAt
	*dest[4].(**string) = s.CronExpression
	*dest[5].(**int) = s.IntervalSeconds
	*dest[6].(*string) = s.Timezone
	*dest[7].(*time.Time) = s.NextRunAt
	return nil
}

type dueTx struct {
	pgx.Tx
	rows      *dueRows
	inserted  int
	updates   [][]any
	committed bool
}

func (tx *dueTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return tx.rows, nil }
func (tx *dueTx) QueryRow(context.Context, string, ...any) pgx.Row {
	if !tx.rows.closed {
		return dueRunRow{err: errors.New("conn busy")}
	}
	tx.inserted++
	return dueRunRow{id: fmt.Sprintf("run-%d", tx.inserted)}
}
func (tx *dueTx) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	if !tx.rows.closed {
		return pgconn.CommandTag{}, errors.New("conn busy")
	}
	tx.updates = append(tx.updates, args)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func (tx *dueTx) Commit(context.Context) error   { tx.committed = true; return nil }
func (tx *dueTx) Rollback(context.Context) error { return nil }

type dueRunRow struct {
	id  string
	err error
}

func (r dueRunRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*string) = r.id
	return nil
}

type dueDB struct{ tx *dueTx }

func (db dueDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) { return db.tx, nil }
func (db dueDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("unexpected database write outside transaction")
}

type dueQueue struct {
	tx   *dueTx
	runs []any
}

func (q *dueQueue) LPush(_ context.Context, key string, values ...any) *redis.IntCmd {
	if !q.tx.committed {
		return redis.NewIntResult(0, errors.New("enqueued before commit"))
	}
	if key != queueName {
		return redis.NewIntResult(0, errors.New("incorrect queue"))
	}
	q.runs = append(q.runs, values...)
	return redis.NewIntResult(1, nil)
}
func TestProcessDueClosesRowsBeforeCreatingRuns(t *testing.T) {
	now := time.Now().UTC()
	interval := 60
	cron := "*/5 * * * *"
	for _, tc := range []struct {
		name      string
		schedules []dueSchedule
		wantRuns  int
	}{
		{name: "no due schedules"},
		{name: "once", schedules: []dueSchedule{{ID: "once", JobID: "job", Type: "once", RunAt: &now}}, wantRuns: 1},
		{name: "interval", schedules: []dueSchedule{{ID: "interval", JobID: "job", Type: "interval", IntervalSeconds: &interval}}, wantRuns: 1},
		{name: "cron", schedules: []dueSchedule{{ID: "cron", JobID: "job", Type: "cron", CronExpression: &cron, Timezone: "UTC"}}, wantRuns: 1},
		{name: "multiple locked schedules", schedules: []dueSchedule{{ID: "one", JobID: "job", Type: "once", RunAt: &now}, {ID: "two", JobID: "job", Type: "interval", IntervalSeconds: &interval}}, wantRuns: 2},
		{name: "invalid schedule disabled after closing rows", schedules: []dueSchedule{{ID: "invalid", JobID: "job", Type: "invalid"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows := &dueRows{items: tc.schedules, index: -1}
			tx := &dueTx{rows: rows}
			queue := &dueQueue{tx: tx}
			if err := processDue(context.Background(), dueDB{tx: tx}, queue); err != nil {
				t.Fatal(err)
			}
			if !rows.closed || !tx.committed {
				t.Fatal("results must close and transaction must commit")
			}
			if len(queue.runs) != tc.wantRuns || tx.inserted != tc.wantRuns {
				t.Fatalf("queued %d, inserted %d; want %d", len(queue.runs), tx.inserted, tc.wantRuns)
			}
			if len(tx.updates) != len(tc.schedules) {
				t.Fatalf("got %d schedule updates; want %d", len(tx.updates), len(tc.schedules))
			}
			for i, s := range tc.schedules {
				if s.Type == "once" && (tx.updates[i][1] != false || tx.updates[i][2].(*time.Time) != nil) {
					t.Fatal("one-time schedule should become inactive after dispatch")
				}
			}
		})
	}
}
