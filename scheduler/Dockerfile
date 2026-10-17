FROM golang:1.26.5 AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY scheduler ./scheduler
RUN CGO_ENABLED=0 go build -o /out/scheduler ./scheduler

FROM alpine:3.22

COPY --from=build /out/scheduler /usr/local/bin/scheduler

ENTRYPOINT ["/usr/local/bin/scheduler"]
