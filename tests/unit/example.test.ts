import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { spy, stub } from "@std/testing/mock";

// Example calculator class to test
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    if (b === 0) {
      throw new Error("Division by zero");
    }
    return a / b;
  }

  async asyncOperation(value: number): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, 100));
    return value * 2;
  }
}

describe("Calculator", () => {
  let calculator: Calculator;

  beforeEach(() => {
    // Setup before each test
    calculator = new Calculator();
  });

  afterEach(() => {
    // Cleanup after each test
    // In a real test, you might clean up resources here
  });

  describe("add", () => {
    it("should add two positive numbers", () => {
      const result = calculator.add(2, 3);
      assertEquals(result, 5);
    });

    it("should handle negative numbers", () => {
      const result = calculator.add(-5, 3);
      assertEquals(result, -2);
    });

    it("should handle zero", () => {
      const result = calculator.add(0, 0);
      assertEquals(result, 0);
    });
  });

  describe("subtract", () => {
    it("should subtract two numbers", () => {
      const result = calculator.subtract(10, 4);
      assertEquals(result, 6);
    });

    it("should handle negative results", () => {
      const result = calculator.subtract(3, 5);
      assertEquals(result, -2);
    });
  });

  describe("multiply", () => {
    it("should multiply two numbers", () => {
      const result = calculator.multiply(4, 5);
      assertEquals(result, 20);
    });

    it("should handle multiplication by zero", () => {
      const result = calculator.multiply(10, 0);
      assertEquals(result, 0);
    });
  });

  describe("divide", () => {
    it("should divide two numbers", () => {
      const result = calculator.divide(10, 2);
      assertEquals(result, 5);
    });

    it("should handle decimal results", () => {
      const result = calculator.divide(7, 2);
      assertEquals(result, 3.5);
    });

    it("should throw error when dividing by zero", () => {
      assertThrows(
        () => calculator.divide(10, 0),
        Error,
        "Division by zero"
      );
    });
  });

  describe("asyncOperation", () => {
    it("should double the value asynchronously", async () => {
      const result = await calculator.asyncOperation(5);
      assertEquals(result, 10);
    });

    it("should handle zero", async () => {
      const result = await calculator.asyncOperation(0);
      assertEquals(result, 0);
    });
  });

  describe("instance", () => {
    it("should create a calculator instance", () => {
      assertExists(calculator);
      assertEquals(typeof calculator.add, "function");
      assertEquals(typeof calculator.subtract, "function");
      assertEquals(typeof calculator.multiply, "function");
      assertEquals(typeof calculator.divide, "function");
    });
  });
});

// Example of using spies and stubs
describe("Calculator with mocks", () => {
  it("should spy on method calls", () => {
    const calculator = new Calculator();
    const addSpy = spy(calculator, "add");

    calculator.add(2, 3);
    calculator.add(4, 5);

    assertEquals(addSpy.calls.length, 2);
    assertEquals(addSpy.calls[0].args, [2, 3]);
    assertEquals(addSpy.calls[1].args, [4, 5]);
  });

  it("should stub a method", () => {
    const calculator = new Calculator();
    const multiplyStub = stub(calculator, "multiply", () => 100);

    const result = calculator.multiply(2, 3);
    assertEquals(result, 100); // Stubbed value

    multiplyStub.restore();
    const realResult = calculator.multiply(2, 3);
    assertEquals(realResult, 6); // Real value after restore
  });
});