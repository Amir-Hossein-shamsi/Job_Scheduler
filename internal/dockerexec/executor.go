package dockerexec

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/strslice"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

const (
	defaultImage       = "job-scheduler-worker:latest"
	defaultMemoryBytes = 256 * 1024 * 1024
	defaultNanoCPUs    = 500_000_000
	defaultPidsLimit   = 128
)

// Executor runs non-SQL jobs in short-lived Docker containers.
type Executor struct {
	client          *client.Client
	image           string
	scriptsHostPath string
	memoryBytes     int64
	nanoCPUs        int64
	pidsLimit       int64
	networkDisabled bool
}

// Result contains the process exit code and any execution error.
type Result struct {
	ExitCode int64
	Err      error
}

// NewFromEnv creates an executor using Docker and runtime settings from the environment.
func NewFromEnv() (*Executor, error) {
	scriptsHostPath := strings.TrimSpace(os.Getenv("SCRIPTS_HOST_PATH"))
	if scriptsHostPath == "" {
		return nil, errors.New("SCRIPTS_HOST_PATH is required for Docker job execution")
	}
	if !filepath.IsAbs(scriptsHostPath) {
		return nil, errors.New("SCRIPTS_HOST_PATH must be an absolute host path")
	}
	scriptsHostPath = filepath.Clean(scriptsHostPath)

	dockerClient, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("create Docker client: %w", err)
	}

	executor := &Executor{
		client:          dockerClient,
		image:           envOrDefault("JOB_CONTAINER_IMAGE", defaultImage),
		scriptsHostPath: scriptsHostPath,
		memoryBytes:     defaultMemoryBytes,
		nanoCPUs:        defaultNanoCPUs,
		pidsLimit:       defaultPidsLimit,
		networkDisabled: true,
	}

	if value := strings.TrimSpace(os.Getenv("JOB_CONTAINER_MEMORY_BYTES")); value != "" {
		executor.memoryBytes, err = strconv.ParseInt(value, 10, 64)
		if err != nil || executor.memoryBytes < 1 {
			_ = dockerClient.Close()
			return nil, errors.New("JOB_CONTAINER_MEMORY_BYTES must be a positive integer")
		}
	}
	if value := strings.TrimSpace(os.Getenv("JOB_CONTAINER_NANO_CPUS")); value != "" {
		executor.nanoCPUs, err = strconv.ParseInt(value, 10, 64)
		if err != nil || executor.nanoCPUs < 1 {
			_ = dockerClient.Close()
			return nil, errors.New("JOB_CONTAINER_NANO_CPUS must be a positive integer")
		}
	}
	if value := strings.TrimSpace(os.Getenv("JOB_CONTAINER_PIDS_LIMIT")); value != "" {
		executor.pidsLimit, err = strconv.ParseInt(value, 10, 64)
		if err != nil || executor.pidsLimit < 1 {
			_ = dockerClient.Close()
			return nil, errors.New("JOB_CONTAINER_PIDS_LIMIT must be a positive integer")
		}
	}
	if value := strings.TrimSpace(os.Getenv("JOB_CONTAINER_NETWORK_DISABLED")); value != "" {
		executor.networkDisabled, err = strconv.ParseBool(value)
		if err != nil {
			_ = dockerClient.Close()
			return nil, errors.New("JOB_CONTAINER_NETWORK_DISABLED must be true or false")
		}
	}

	return executor, nil
}

// Close releases the Docker client resources.
func (e *Executor) Close() error {
	if e == nil || e.client == nil {
		return nil
	}
	return e.client.Close()
}

// Run creates, starts, attaches to, and removes one container for a job run.
func (e *Executor) Run(
	ctx context.Context,
	runID string,
	scriptType string,
	scriptPath string,
	args []string,
	env []string,
	workingDir string,
	stdout io.Writer,
	stderr io.Writer,
) Result {
	command, err := commandFor(scriptType, scriptPath, args)
	if err != nil {
		return Result{Err: err}
	}
	return e.runCommand(ctx, runID, command, env, workingDir, e.networkDisabled, stdout, stderr)
}

// RunSQL executes a SQL script through the SQL runner with network access enabled.
func (e *Executor) RunSQL(
	ctx context.Context,
	runID string,
	scriptPath string,
	connectionJSON []byte,
	credentialsKey string,
	stdout io.Writer,
	stderr io.Writer,
) Result {
	env := []string{
		"SQL_SCRIPT_PATH=" + scriptPath,
		"SQL_CONNECTION_JSON=" + string(connectionJSON),
		"SQL_CREDENTIALS_KEY=" + credentialsKey,
	}
	return e.runCommand(
		ctx,
		runID,
		[]string{"/usr/local/bin/sqlrunner"},
		env,
		"/scripts",
		false,
		stdout,
		stderr,
	)
}

func (e *Executor) runCommand(
	ctx context.Context,
	runID string,
	command []string,
	env []string,
	workingDir string,
	networkDisabled bool,
	stdout io.Writer,
	stderr io.Writer,
) Result {

	config := &container.Config{
		Image:        e.image,
		Entrypoint:   strslice.StrSlice{},
		Cmd:          command,
		Env:          env,
		WorkingDir:   workingDir,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          false,
		Labels: map[string]string{
			"job-scheduler.run-id": runID,
		},
	}

	pidsLimit := e.pidsLimit
	hostConfig := &container.HostConfig{
		AutoRemove:     false,
		ReadonlyRootfs: true,
		NetworkMode:    container.NetworkMode("none"),
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges:true"},
		Resources: container.Resources{
			Memory:    e.memoryBytes,
			NanoCPUs:  e.nanoCPUs,
			PidsLimit: &pidsLimit,
		},
		Mounts: []mount.Mount{
			{
				Type:     mount.TypeBind,
				Source:   e.scriptsHostPath,
				Target:   "/scripts",
				ReadOnly: true,
			},
			{
				Type:   mount.TypeTmpfs,
				Target: "/tmp",
				TmpfsOptions: &mount.TmpfsOptions{
					SizeBytes: 64 * 1024 * 1024,
					Mode:      0o1777,
				},
			},
		},
	}
	if !networkDisabled {
		hostConfig.NetworkMode = "default"
		config.NetworkDisabled = false
	} else {
		config.NetworkDisabled = true
	}

	created, err := e.client.ContainerCreate(ctx, config, hostConfig, nil, nil, "")
	if err != nil {
		return Result{Err: fmt.Errorf("create job container: %w", err)}
	}
	containerID := created.ID
	defer e.cleanup(containerID)

	attached, err := e.client.ContainerAttach(ctx, containerID, container.AttachOptions{
		Stream: true,
		Stdout: true,
		Stderr: true,
	})
	if err != nil {
		return Result{Err: fmt.Errorf("attach to job container: %w", err)}
	}
	defer attached.Close()

	if err := e.client.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return Result{Err: fmt.Errorf("start job container: %w", err)}
	}

	copyDone := make(chan error, 1)
	go func() {
		_, copyErr := stdcopy.StdCopy(stdout, stderr, attached.Reader)
		copyDone <- copyErr
	}()

	waitCh, waitErrCh := e.client.ContainerWait(ctx, containerID, container.WaitConditionNotRunning)
	select {
	case response := <-waitCh:
		if response.Error != nil {
			return Result{Err: fmt.Errorf("wait for job container: %s", response.Error.Message)}
		}
		if copyErr := <-copyDone; copyErr != nil && !errors.Is(copyErr, io.EOF) {
			return Result{ExitCode: response.StatusCode, Err: fmt.Errorf("read job output: %w", copyErr)}
		}
		if response.StatusCode != 0 {
			return Result{ExitCode: response.StatusCode, Err: fmt.Errorf("job container exited with status %d", response.StatusCode)}
		}
		return Result{ExitCode: 0}
	case err := <-waitErrCh:
		return Result{Err: fmt.Errorf("wait for job container: %w", err)}
	case <-ctx.Done():
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		stopErr := e.client.ContainerStop(stopCtx, containerID, container.StopOptions{Timeout: ptr(2)})
		cancel()
		if stopErr != nil && !errors.Is(stopErr, context.Canceled) {
			return Result{Err: fmt.Errorf("stop timed-out job container: %w", stopErr)}
		}
		return Result{Err: ctx.Err()}
	}
}

func (e *Executor) cleanup(containerID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = e.client.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
}

func commandFor(scriptType, scriptPath string, args []string) ([]string, error) {
	commandArgs := append([]string{scriptPath}, args...)
	switch strings.ToLower(strings.TrimSpace(scriptType)) {
	case "python":
		return append([]string{"python3"}, commandArgs...), nil
	case "node":
		return append([]string{"node"}, commandArgs...), nil
	case "bash":
		return append([]string{"bash"}, commandArgs...), nil
	case "go":
		return append([]string{"go", "run"}, commandArgs...), nil
	default:
		return nil, fmt.Errorf("unsupported script type %q", scriptType)
	}
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func ptr[T any](value T) *T { return &value }
