package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type authDatabase interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type authService struct {
	db     authDatabase
	secret []byte
}

type authClaims struct {
	Email string `json:"email"`
	Role  string `json:"role"`
	jwt.RegisteredClaims
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token string `json:"token"`
}

type meResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

type contextKey string

const authClaimsKey contextKey = "authClaims"

// newAuthService creates an authentication service using the database pool and JWT secret.
func newAuthService(db *pgxpool.Pool, secret string) *authService {
	return &authService{
		db:     db,
		secret: []byte(secret),
	}
}

// seedAdmin inserts the configured admin account if its email does not already exist.
func (a *authService) seedAdmin(ctx context.Context) error {
	email := strings.TrimSpace(strings.ToLower(os.Getenv("ADMIN_EMAIL")))
	username := strings.TrimSpace(os.Getenv("ADMIN_USERNAME"))
	password := os.Getenv("ADMIN_PASSWORD")

	if email == "" || username == "" || password == "" {
		return errors.New("ADMIN_EMAIL, ADMIN_USERNAME, and ADMIN_PASSWORD are required")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	_, err = a.db.Exec(ctx, `
		INSERT INTO users (email, username, password_hash, role)
		VALUES ($1, $2, $3, 'admin')
		ON CONFLICT (email) DO NOTHING
	`, email, username, string(hash))

	return err
}

// login verifies admin credentials and returns a JWT.
//
// @Summary Login
// @Tags Auth
// @Accept json
// @Produce json
// @Param request body loginRequest true "Admin credentials"
// @Success 200 {object} loginResponse
// @Failure 400 {string} string "Invalid request"
// @Failure 401 {string} string "Invalid credentials"
// @Failure 500 {string} string "Internal server error"
// @Router /api/auth/login [post]
func (a *authService) login(w http.ResponseWriter, r *http.Request) {
	var input loginRequest

	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(&input); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(w, "request must contain a single JSON object", http.StatusBadRequest)
		return
	}

	input.Email = strings.TrimSpace(strings.ToLower(input.Email))
	if input.Email == "" || input.Password == "" {
		http.Error(w, "email and password are required", http.StatusBadRequest)
		return
	}

	var userID, email, passwordHash, role string
	err := a.db.QueryRow(r.Context(), `
		SELECT id::text, email, password_hash, role
		FROM users
		WHERE email = $1
	`, input.Email).Scan(&userID, &email, &passwordHash, &role)

	if errors.Is(err, pgx.ErrNoRows) {
		http.Error(w, "invalid email or password", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, "could not look up user", http.StatusInternalServerError)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(input.Password)) != nil {
		http.Error(w, "invalid email or password", http.StatusUnauthorized)
		return
	}
	if role != "admin" {
		http.Error(w, "invalid email or password", http.StatusUnauthorized)
		return
	}

	now := time.Now()
	claims := authClaims{
		Email: email,
		Role:  role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(a.secret)
	if err != nil {
		http.Error(w, "could not create token", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"token": tokenString})
}

// requireAuth validates a bearer JWT and passes its claims to the protected handler.
func (a *authService) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fields := strings.Fields(r.Header.Get("Authorization"))
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			http.Error(w, "authentication required", http.StatusUnauthorized)
			return
		}

		claims := &authClaims{}
		token, err := jwt.ParseWithClaims(
			fields[1],
			claims,
			func(token *jwt.Token) (any, error) {
				return a.secret, nil
			},
			jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		)
		if err != nil || !token.Valid || claims.Role != "admin" {
			http.Error(w, "invalid or expired token", http.StatusUnauthorized)
			return
		}

		// A signed token can outlive its user after a database reset or account
		// removal. Check the current account before handlers write foreign keys.
		var activeAdmin bool
		err = a.db.QueryRow(r.Context(), `
			SELECT EXISTS (
				SELECT 1 FROM users
				WHERE id::text = $1 AND email = $2 AND role = 'admin'
			)
		`, claims.Subject, claims.Email).Scan(&activeAdmin)
		if err != nil {
			http.Error(w, "could not verify admin session; please try again", http.StatusServiceUnavailable)
			return
		}
		if !activeAdmin {
			http.Error(w, "admin session is no longer valid; please sign in again", http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), authClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// me returns the authenticated admin's profile.
//
// @Summary Get current admin
// @Tags Auth
// @Produce json
// @Security BearerAuth
// @Success 200 {object} meResponse
// @Failure 401 {string} string "Authentication required"
// @Router /api/auth/me [get]
func (a *authService) me(w http.ResponseWriter, r *http.Request) {
	claims, ok := r.Context().Value(authClaimsKey).(*authClaims)
	if !ok {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"id":    claims.Subject,
		"email": claims.Email,
		"role":  claims.Role,
	})
}

// writeJSON sends a value as a JSON response with the given HTTP status.
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
