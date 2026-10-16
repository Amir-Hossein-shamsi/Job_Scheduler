FROM golang:1.26.5 AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY api ./api
COPY docs ./docs
COPY internal ./internal

RUN CGO_ENABLED=0 go build -o /out/api ./api

FROM alpine:3.22

COPY --from=build /out/api /usr/local/bin/api

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/api"]
