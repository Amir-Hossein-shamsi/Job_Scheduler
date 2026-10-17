package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"job_scheduler/internal/sqljob"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run(parent context.Context) error {
	scriptPath := strings.TrimSpace(os.Getenv("SQL_SCRIPT_PATH"))
	if scriptPath == "" {
		return errors.New("SQL_SCRIPT_PATH is required")
	}

	connectionJSON := strings.TrimSpace(os.Getenv("SQL_CONNECTION_JSON"))
	if connectionJSON == "" {
		return errors.New("SQL_CONNECTION_JSON is required")
	}

	var connection sqljob.StoredConnection
	if err := json.Unmarshal([]byte(connectionJSON), &connection); err != nil {
		return errors.New("SQL connection configuration is invalid")
	}

	credentialBox, err := sqljob.NewSecretBoxFromEnv()
	if err != nil {
		return err
	}
	password, err := credentialBox.Decrypt(connection.PasswordEncrypted)
	if err != nil {
		return err
	}

	script, err := os.ReadFile(scriptPath)
	if err != nil {
		return fmt.Errorf("read SQL script: %w", err)
	}
	if strings.TrimSpace(string(script)) == "" {
		return errors.New("SQL script is empty")
	}

	targetDB, err := connection.OpenDB(parent, password)
	if err != nil {
		return errors.New(redactPassword(err.Error(), password))
	}
	defer targetDB.Close()

	result, err := targetDB.ExecContext(parent, string(script))
	if err != nil {
		return errors.New(redactPassword(err.Error(), password))
	}

	if rowsAffected, err := result.RowsAffected(); err == nil {
		fmt.Printf("SQL script completed; rows affected: %d\n", rowsAffected)
	} else {
		fmt.Println("SQL script completed")
	}
	return nil
}

func redactPassword(message, password string) string {
	if password == "" {
		return message
	}
	return strings.ReplaceAll(message, password, "[REDACTED]")
}
