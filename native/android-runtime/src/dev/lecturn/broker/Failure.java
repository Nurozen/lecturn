package dev.lecturn.broker;
final class Failure extends Exception {
    private static final long serialVersionUID = 1L;
    final int status;
    Failure(int status, String code) { super(code); this.status = status; }
}
