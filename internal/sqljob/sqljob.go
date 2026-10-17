package sqljob

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/microsoft/go-mssqldb"
	go_ora "github.com/sijms/go-ora/v2"
)

type StoredConnection struct {
	Engine                 string `json:"engine"`
	Host                   string `json:"host"`
	Port                   int    `json:"port"`
	Database               string `json:"database"`
	Username               string `json:"username"`
	PasswordEncrypted      string `json:"password_encrypted"`
	TLS                    bool   `json:"tls_enabled"`
	TrustServerCertificate bool   `json:"trust_server_certificate,omitempty"`
}

type SecretBox struct {
	aead cipher.AEAD
}

// NewSecretBoxFromEnv loads the shared API and worker encryption key.
func NewSecretBoxFromEnv() (*SecretBox, error) {
	encodedKey := strings.TrimSpace(os.Getenv("SQL_CREDENTIALS_KEY"))
	if encodedKey == "" {
		return nil, errors.New("SQL_CREDENTIALS_KEY is required")
	}

	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil {
		return nil, errors.New("SQL_CREDENTIALS_KEY must be base64 encoded")
	}
	if len(key) != 32 {
		return nil, errors.New("SQL_CREDENTIALS_KEY must decode to exactly 32 bytes")
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create encryption cipher: %w", err)
	}

	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create encryption mode: %w", err)
	}

	return &SecretBox{aead: aead}, nil
}

// Encrypt protects a database password before it is stored in PostgreSQL.
func (box *SecretBox) Encrypt(plaintext string) (string, error) {
	nonce := make([]byte, box.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate encryption nonce: %w", err)
	}

	ciphertext := box.aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt opens a password previously encrypted by Encrypt.
func (box *SecretBox) Decrypt(encoded string) (string, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("stored database password is invalid")
	}
	if len(ciphertext) < box.aead.NonceSize() {
		return "", errors.New("stored database password is incomplete")
	}

	nonce := ciphertext[:box.aead.NonceSize()]
	encryptedPassword := ciphertext[box.aead.NonceSize():]

	plaintext, err := box.aead.Open(nil, nonce, encryptedPassword, nil)
	if err != nil {
		return "", errors.New("could not decrypt stored database password")
	}

	return string(plaintext), nil
}

// OpenDB connects to the configured SQL database and verifies the connection.
func (connection StoredConnection) OpenDB(
	ctx context.Context,
	password string,
) (*sql.DB, error) {
	var (
		driverName string
		dataSource string
	)

	address := net.JoinHostPort(connection.Host, strconv.Itoa(connection.Port))

	switch connection.Engine {
	case "postgres":
		driverName = "pgx"

		sslMode := "disable"
		if connection.TLS {
			sslMode = "require"
		}

		dsn := url.URL{
			Scheme: "postgres",
			User:   url.UserPassword(connection.Username, password),
			Host:   address,
			Path:   "/" + connection.Database,
		}
		query := dsn.Query()
		query.Set("sslmode", sslMode)
		// SQL files may contain multiple statements in one script.
		query.Set("default_query_exec_mode", "simple_protocol")
		dsn.RawQuery = query.Encode()
		dataSource = dsn.String()

	case "mysql":
		driverName = "mysql"

		config := mysqlConfig(connection, password)
		dataSource = config.FormatDSN()

	case "sqlserver":
		driverName = "sqlserver"

		dsn := url.URL{
			Scheme: "sqlserver",
			User:   url.UserPassword(connection.Username, password),
			Host:   address,
		}
		query := dsn.Query()
		query.Set("database", connection.Database)
		query.Set("encrypt", strconv.FormatBool(connection.TLS))
		query.Set(
			"TrustServerCertificate",
			strconv.FormatBool(connection.TrustServerCertificate),
		)
		dsn.RawQuery = query.Encode()
		dataSource = dsn.String()

	case "oracle":
		driverName = "oracle"
		dataSource = goOracleURL(
			connection.Host,
			connection.Port,
			connection.Database,
			connection.Username,
			password,
			connection.TLS,
		)

	default:
		return nil, fmt.Errorf("unsupported SQL engine %q", connection.Engine)
	}

	db, err := sql.Open(driverName, dataSource)
	if err != nil {
		return nil, fmt.Errorf("open target database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(0)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connect to target database: %w", err)
	}

	return db, nil
}

func goOracleURL(host string, port int, service, username, password string, tlsEnabled bool) string {
	options := map[string]string{}
	if tlsEnabled {
		options["SSL"] = "true"
	}
	return go_ora.BuildUrl(host, port, service, username, password, options)
}

// mysqlConfig creates a MySQL DSN without manually concatenating credentials.
func mysqlConfig(connection StoredConnection, password string) *mysql.Config {
	config := mysql.NewConfig()
	config.User = connection.Username
	config.Passwd = password
	config.Net = "tcp"
	config.Addr = net.JoinHostPort(connection.Host, strconv.Itoa(connection.Port))
	config.DBName = connection.Database
	config.MultiStatements = true

	if connection.TLS {
		config.TLSConfig = "true"
	}

	return config
}
