//
//  BridgeServer.swift
//  幻梦圆环 · macOS 版
//
//  单客户端 WebSocket 服务端：插件（Photoshop UXP）是客户端，圆环是 127.0.0.1 上的服务端。
//    - 用 POSIX socket（不用 Network.framework），后台线程跑 accept 循环；
//    - 手写 HTTP Upgrade 握手（Sec-WebSocket-Key + SHA1(key+GUID) → base64）；
//    - 手写 WebSocket 帧收发：FIN / opcode / 126 / 127 / 掩码 / 分片 / ping-pong / close，
//      单帧上限 32MB；
//    - send 加锁；start() 同步 bind+listen，端口被占用返回 false；
//    - onMessage / onConnectionChanged / onStartFailure 一律切主线程回调。
//
//  SHA1 用 CryptoKit 的 Insecure.SHA1（仅用于 WebSocket 握手，不用于安全场景）。
//

import Foundation
import Darwin
import CryptoKit

/// 单客户端 WebSocket 服务端。主线程创建/启动/停止，回调切回主线程。
final class BridgeServer {
    private let _port: Int
    private let sendLock = NSLock()

    private var listenFD: Int32 = -1
    private var clientFD: Int32 = -1
    private var running = false
    private var connected = false
    /// 每次 start() 自增；旧 accept 线程看到代数不一致就退出，避免 stop 后立刻 start 时两个线程抢 accept
    private var generation: UInt64 = 0
    private var acceptThread: Thread?

    var port: Int { _port }

    var isConnected: Bool {
        sendLock.lock()
        defer { sendLock.unlock() }
        return connected
    }

    /// 收到一条文本消息（主线程回调）
    var onMessage: ((String) -> Void)?
    /// 连接状态变化（主线程回调）
    var onConnectionChanged: ((Bool) -> Void)?
    /// 启动失败（可选，主线程回调）
    var onStartFailure: ((String) -> Void)?

    init(port: Int) {
        self._port = port
    }

    deinit {
        stop()
    }

    // MARK: - 启动 / 停止

    func start() -> Bool {
        sendLock.lock()
        let alreadyRunning = running
        sendLock.unlock()
        if alreadyRunning { return true }

        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 {
            return failToStart("创建 socket 失败：\(BridgeServer.errnoText())")
        }
        // 端口 TIME_WAIT 时也能重新绑定
        setIntOption(fd, SOL_SOCKET, SO_REUSEADDR, 1)

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(truncatingIfNeeded: _port)).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addressPointer in
                Darwin.bind(fd, addressPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bindResult != 0 {
            let message = BridgeServer.errnoText()
            _ = Darwin.close(fd)
            return failToStart("绑定 127.0.0.1:\(_port) 失败：\(message)")
        }
        if Darwin.listen(fd, 16) != 0 {
            let message = BridgeServer.errnoText()
            _ = Darwin.close(fd)
            return failToStart("监听 127.0.0.1:\(_port) 失败：\(message)")
        }

        sendLock.lock()
        generation &+= 1
        let token = generation
        listenFD = fd
        running = true
        sendLock.unlock()

        let thread = Thread { [weak self] in
            guard let self = self else { return }
            self.acceptLoop(token: token)
        }
        thread.name = "HuanmengRingBridge"
        acceptThread = thread
        thread.start()
        return true
    }

    func stop() {
        sendLock.lock()
        running = false
        let listener = listenFD
        listenFD = -1
        let client = clientFD
        let wasConnected = connected
        clientFD = -1
        connected = false
        sendLock.unlock()

        if listener >= 0 {
            _ = shutdown(listener, SHUT_RDWR)
            _ = Darwin.close(listener)
        }
        if client >= 0 {
            _ = shutdown(client, SHUT_RDWR)
            _ = Darwin.close(client)
        }
        if wasConnected {
            raiseConnection(false)
        }
    }

    // MARK: - 发送

    func send(_ text: String) -> Bool {
        if text.isEmpty { return false }
        return sendFrame(opcode: 0x1, payload: Array(text.utf8))
    }

    // MARK: - accept 循环（后台线程）

    private func acceptLoop(token: UInt64) {
        while isRunning(token) {
            sendLock.lock()
            let listener = listenFD
            sendLock.unlock()
            if listener < 0 { return }

            // 用 250ms 超时的 poll 代替阻塞 accept：stop() 后线程最多 250ms 内退出
            var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 250)
            if ready < 0 {
                if errno == EINTR { continue }
                if !isRunning(token) { return }
                Thread.sleep(forTimeInterval: 0.2)
                continue
            }
            if ready == 0 { continue }
            if !isRunning(token) { return }

            var clientAddress = sockaddr_in()
            var clientAddressLength = socklen_t(MemoryLayout<sockaddr_in>.size)
            let incoming = withUnsafeMutablePointer(to: &clientAddress) { pointer -> Int32 in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addressPointer in
                    accept(listener, addressPointer, &clientAddressLength)
                }
            }
            if incoming < 0 {
                if !isRunning(token) { return }
                Thread.sleep(forTimeInterval: 0.2)
                continue
            }
            handleConnection(incoming, token: token)
        }
    }

    private func handleConnection(_ newClient: Int32, token: UInt64) {
        setIntOption(newClient, IPPROTO_TCP, TCP_NODELAY, 1)
        // 写一个已断开的 socket 时不要让进程吃 SIGPIPE
        setIntOption(newClient, SOL_SOCKET, SO_NOSIGPIPE, 1)
        setTimevalOption(newClient, SO_RCVTIMEO, milliseconds: 10000)

        guard handshake(newClient) else {
            _ = Darwin.close(newClient)
            return
        }

        sendLock.lock()
        if !running || generation != token {
            sendLock.unlock()
            _ = Darwin.close(newClient)
            return
        }
        // 新连接顶掉旧连接。插件重连时旧 socket 可能还没死。
        closeClientLocked()
        clientFD = newClient
        connected = true
        sendLock.unlock()

        setTimevalOption(newClient, SO_RCVTIMEO, milliseconds: 0)
        setTimevalOption(newClient, SO_SNDTIMEO, milliseconds: 8000)

        raiseConnection(true)
        readLoop(fd: newClient, token: token)

        sendLock.lock()
        let wasCurrent = (clientFD == newClient)
        if wasCurrent {
            closeClientLocked()
        }
        sendLock.unlock()
        if wasCurrent {
            raiseConnection(false)
        }
    }

    // MARK: - 握手

    private func handshake(_ fd: Int32) -> Bool {
        var header: [UInt8] = []
        header.reserveCapacity(1024)
        var matched = 0
        while matched < 4 {
            guard let byte = readByte(fd) else { return false }
            header.append(byte)
            if (matched == 0 || matched == 2) && byte == 0x0D {
                matched += 1
            } else if (matched == 1 || matched == 3) && byte == 0x0A {
                matched += 1
            } else {
                matched = 0
            }
            if header.count > 16384 { return false }
        }

        guard let text = String(bytes: header, encoding: .utf8) else { return false }

        var key: String?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let colon = line.firstIndex(of: ":"), colon > line.startIndex else { continue }
            let name = String(line[..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
            if name == "sec-websocket-key" {
                key = String(line[line.index(after: colon)...])
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                break
            }
        }
        guard let webSocketKey = key else { return false }

        let accept = BridgeServer.webSocketAccept(webSocketKey)
        let response = "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
        return writeAll(fd, Array(response.utf8))
    }

    private static func webSocketAccept(_ key: String) -> String {
        let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let digest = Insecure.SHA1.hash(data: Data((key + guid).utf8))
        return Data(digest).base64EncodedString()
    }

    // MARK: - 读循环

    private func readLoop(fd: Int32, token: UInt64) {
        var fragment: [UInt8] = []
        while isRunning(token) {
            guard let first = readByte(fd) else { return }
            guard let second = readByte(fd) else { return }

            let isFinal = (first & 0x80) != 0
            let opcode = first & 0x0F
            let masked = (second & 0x80) != 0
            var length = UInt64(second & 0x7F)

            if length == 126 {
                guard let extended = readExact(fd, 2) else { return }
                length = (UInt64(extended[0]) << 8) | UInt64(extended[1])
            } else if length == 127 {
                guard let extended = readExact(fd, 8) else { return }
                length = 0
                for index in 0..<8 {
                    length = (length << 8) | UInt64(extended[index])
                }
            }

            var mask: [UInt8]?
            if masked {
                guard let maskBytes = readExact(fd, 4) else { return }
                mask = maskBytes
            }
            if length > 32 * 1024 * 1024 { return }

            var payload: [UInt8] = []
            let payloadLength = Int(length)
            if payloadLength > 0 {
                guard let payloadBytes = readExact(fd, payloadLength) else { return }
                payload = payloadBytes
            }
            if let mask = mask {
                for index in 0..<payload.count {
                    payload[index] ^= mask[index % 4]
                }
            }

            switch opcode {
            case 0x8: // close：回一个 close 帧后结束
                _ = sendFrame(opcode: 0x8, payload: [])
                return
            case 0x9: // ping → pong
                _ = sendFrame(opcode: 0xA, payload: payload)
            case 0xA: // pong：忽略
                break
            case 0x1, 0x2: // 文本帧 / 二进制帧
                if isFinal {
                    raiseMessage(String(decoding: payload, as: UTF8.self))
                } else {
                    fragment = payload
                }
            case 0x0: // 续帧
                fragment.append(contentsOf: payload)
                if isFinal {
                    raiseMessage(String(decoding: fragment, as: UTF8.self))
                    fragment = []
                }
            default:
                break
            }
        }
    }

    private func readByte(_ fd: Int32) -> UInt8? {
        var byte: UInt8 = 0
        while true {
            let count = Darwin.read(fd, &byte, 1)
            if count == 1 { return byte }
            if count < 0 && errno == EINTR { continue }
            return nil
        }
    }

    private func readExact(_ fd: Int32, _ count: Int) -> [UInt8]? {
        if count <= 0 { return [] }
        var buffer = [UInt8](repeating: 0, count: count)
        var offset = 0
        while offset < count {
            // 用 withUnsafeMutableBufferPointer 而不是 withUnsafeMutableBytes，兼容性更稳
            let readCount = buffer.withUnsafeMutableBufferPointer { pointer -> Int in
                guard let base = pointer.baseAddress else { return -1 }
                let destination = UnsafeMutableRawPointer(base).advanced(by: offset)
                return Darwin.read(fd, destination, count - offset)
            }
            if readCount < 0 && errno == EINTR { continue }
            if readCount <= 0 { return nil }
            offset += readCount
        }
        return buffer
    }

    // MARK: - 帧发送

    @discardableResult
    private func sendFrame(opcode: UInt8, payload: [UInt8]) -> Bool {
        sendLock.lock()
        defer { sendLock.unlock() }

        guard clientFD >= 0 && connected else { return false }

        var frame: [UInt8] = []
        frame.reserveCapacity(payload.count + 10)
        frame.append(0x80 | opcode)
        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else if payload.count <= 0xFFFF {
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xFF))
            frame.append(UInt8(payload.count & 0xFF))
        } else {
            frame.append(127)
            let length = UInt64(payload.count)
            var shift = 56
            while shift >= 0 {
                frame.append(UInt8((length >> UInt64(shift)) & 0xFF))
                shift -= 8
            }
        }
        frame.append(contentsOf: payload)

        if !writeAll(clientFD, frame) {
            Log.write("桥接发送失败：\(BridgeServer.errnoText())")
            connected = false
            return false
        }
        return true
    }

    private func writeAll(_ fd: Int32, _ bytes: [UInt8]) -> Bool {
        if bytes.isEmpty { return true }
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBufferPointer { pointer -> Int in
                guard let base = pointer.baseAddress else { return -1 }
                let source = UnsafeRawPointer(base).advanced(by: offset)
                return Darwin.write(fd, source, bytes.count - offset)
            }
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }

    // MARK: - 回调（统一切主线程）

    private func raiseMessage(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.onMessage?(message)
        }
    }

    private func raiseConnection(_ isConnected: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.onConnectionChanged?(isConnected)
        }
    }

    // MARK: - 内部工具

    /// 是否仍属于当前这一轮 start()（同时判断 running 与代数）。
    private func isRunning(_ token: UInt64) -> Bool {
        sendLock.lock()
        defer { sendLock.unlock() }
        return running && generation == token
    }

    /// 关掉当前客户端（调用方必须持有 sendLock）。
    private func closeClientLocked() {
        connected = false
        if clientFD >= 0 {
            let fd = clientFD
            clientFD = -1
            _ = shutdown(fd, SHUT_RDWR)
            _ = Darwin.close(fd)
        }
    }

    private func failToStart(_ detail: String) -> Bool {
        let message = "桥接端口启动失败 \(_port)：\(detail)"
        Log.write(message)
        DispatchQueue.main.async { [weak self] in
            self?.onStartFailure?(message)
        }
        return false
    }

    private func setIntOption(_ fd: Int32, _ level: Int32, _ name: Int32, _ value: Int32) {
        var optionValue = value
        _ = withUnsafeBytes(of: &optionValue) { raw -> Int32 in
            guard let base = raw.baseAddress else { return -1 }
            return setsockopt(fd, level, name, base, socklen_t(MemoryLayout<Int32>.size))
        }
    }

    /// 毫秒级 socket 超时；传 0 表示不超时（SO_RCVTIMEO / SO_SNDTIMEO）。
    private func setTimevalOption(_ fd: Int32, _ option: Int32, milliseconds: Int) {
        var value = timeval(
            tv_sec: milliseconds / 1000,
            tv_usec: Int32((milliseconds % 1000) * 1000)
        )
        let size = socklen_t(MemoryLayout<timeval>.size)
        _ = withUnsafeBytes(of: &value) { raw -> Int32 in
            guard let base = raw.baseAddress else { return -1 }
            return setsockopt(fd, SOL_SOCKET, option, base, size)
        }
    }

    private static func errnoText() -> String {
        let code = errno
        if let message = strerror(code) {
            return String(cString: message)
        }
        return "错误码 \(code)"
    }
}
