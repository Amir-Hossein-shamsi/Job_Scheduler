package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type sessionTestDB struct {
	active  bool
	err     error
	queried bool
}

func (db *sessionTestDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("session validation must not write to the database")
}

func (db *sessionTestDB) QueryRow(context.Context, string, ...any) pgx.Row {
	db.queried = true
	return sessionTestRow{active: db.active, err: db.err}
}

type sessionTestRow struct {
	active bool
	err    error
}

func (row sessionTestRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	*dest[0].(*bool) = row.active
	return nil
}

func TestRequireAuthChecksCurrentAccount(t *testing.T) {
	for _, tc := range []struct {
		name       string
		active     bool
		dbErr      error
		expired    bool
		wantStatus int
		wantQuery  bool
	}{
		{name: "current administrator", active: true, wantStatus: http.StatusNoContent, wantQuery: true},
		{name: "user missing after database reset", wantStatus: http.StatusUnauthorized, wantQuery: true},
		{name: "database unavailable keeps error distinct from invalid credentials", dbErr: errors.New("database unavailable"), wantStatus: http.StatusServiceUnavailable, wantQuery: true},
		{name: "expired token rejected before database lookup", active: true, expired: true, wantStatus: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := &sessionTestDB{active: tc.active, err: tc.dbErr}
			auth := &authService{db: db, secret: []byte("test-only-signing-secret-at-least-32-bytes")}
			expires := time.Now().Add(time.Hour)
			if tc.expired {
				expires = time.Now().Add(-time.Hour)
			}
			claims := authClaims{Email: "admin@test.example", Role: "admin", RegisteredClaims: jwt.RegisteredClaims{Subject: "removed-admin-id", ExpiresAt: jwt.NewNumericDate(expires)}}
			token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(auth.secret)
			if err != nil {
				t.Fatal(err)
			}
			called := false
			handler := auth.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if _, ok := r.Context().Value(authClaimsKey).(*authClaims); !ok {
					t.Error("missing authenticated claims")
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != tc.wantStatus {
				t.Fatalf("got status %d; want %d", response.Code, tc.wantStatus)
			}
			if called != (tc.wantStatus == http.StatusNoContent) {
				t.Fatalf("protected handler called: %v", called)
			}
			if db.queried != tc.wantQuery {
				t.Fatalf("database queried: %v; want %v", db.queried, tc.wantQuery)
			}
		})
	}
}
