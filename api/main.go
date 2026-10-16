package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"job_scheduler/internal/sqljob"

	_ "job_scheduler/docs"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	httpSwagger "github.com/swaggo/http-swagger/v2"
)

// main connects to PostgreSQL and Redis, registers API routes, and starts the HTTP server.
//
// @title Job Scheduler API
// @version 1.0
// @description Admin API for managing scheduled jobs and their runs.
// @host localhost:8080
// @BasePath /
// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
// @description Enter "Bearer" followed by a space and your JWT.
func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	jwtSecret := os.Getenv("JWT_SECRET")
	if len([]byte(jwtSecret)) < 32 {
		log.Fatal("JWT_SECRET must contain at least 32 bytes")
	}

	credentialBox, err := sqljob.NewSecretBoxFromEnv()
	if err != nil {
		log.Fatalf("load SQL credential encryption key: %v", err)
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		log.Fatalf("create database pool: %v", err)
	}
	defer pool.Close()

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "redis:6379"
	}

	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer redisClient.Close()

	redisCtx, cancelRedis := context.WithTimeout(context.Background(), 5*time.Second)
	err = redisClient.Ping(redisCtx).Err()
	cancelRedis()
	if err != nil {
		log.Fatalf("connect to Redis: %v", err)
	}

	auth := newAuthService(pool, jwtSecret)

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	if err := auth.seedAdmin(startupCtx); err != nil {
		cancelStartup()
		log.Fatalf("seed admin: %v", err)
	}
	cancelStartup()

	router := chi.NewRouter()

	router.Get("/swagger/*", httpSwagger.Handler(
		httpSwagger.URL("http://localhost:8080/swagger/doc.json"),
	))

	runs := newRunHandler(pool, redisClient)

	router.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	router.Get("/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		if err := pool.Ping(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready\n"))
	})

	router.Post("/api/auth/login", auth.login)
	router.With(auth.requireAuth).Get("/api/auth/me", auth.me)

	jobs := newJobsHandler(pool, credentialBox)

	router.With(auth.requireAuth).Get("/api/jobs", jobs.list)
	router.With(auth.requireAuth).Post("/api/jobs", jobs.create)
	router.With(auth.requireAuth).Get("/api/jobs/{id}/runs", runs.list)
	router.With(auth.requireAuth).Post("/api/jobs/{id}/run", runs.trigger)
	router.With(auth.requireAuth).Get("/api/runs/{id}", runs.get)
	router.With(auth.requireAuth).Get("/api/runs/{id}/logs", runs.logs)
	router.With(auth.requireAuth).Get("/api/runs/{id}/logs/stream", runs.stream)

	port := os.Getenv("API_PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	serverErrors := make(chan error, 1)

	go func() {
		log.Printf("API listening on :%s", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErrors <- err
		}
	}()

	select {
	case <-ctx.Done():
		log.Print("shutting down API")
	case err := <-serverErrors:
		log.Printf("HTTP server error: %v", err)
		return
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
		if closeErr := server.Close(); closeErr != nil {
			log.Printf("force close failed: %v", closeErr)
		}
	}
}
