FROM golang:1.26.5 AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY worker ./worker
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /out/worker ./worker

FROM golang:1.26.5-alpine

RUN apk add --no-cache bash nodejs npm python3

COPY --from=build /out/worker /usr/local/bin/worker

ENTRYPOINT ["/usr/local/bin/worker"]
