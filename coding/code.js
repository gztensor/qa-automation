import dotenv from "dotenv";
import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "./config.js";

// Prompt that worked for analyzing vector-store for state updates
//   const prompt = `
// 		You are the senior protocol engineer well familiar with blockchain, Rust, and Substrate.
// 		Attached is the Subtensor code base. It is a substrate based blockchain.
// 		Use it to find the complete list of state maps that are updated when 
// 		add_stake extrinsic is executed successfully. Output only the state map 
// 		names as they are used in this Rust code. Analyze code as deeply as needed.
// 		`.trim();

dotenv.config({ path: "../.env" });
const client = new OpenAI({ apiKey: process.env.OPENAI_KEY, timeout: 360_000 });

async function readFile(filePath) {
	const file = path.resolve(process.cwd(), filePath);
	try {
		const data = await fs.readFile(file, "utf8");
		return data;
	} catch (err) {
		if (err && err.code === "ENOENT") return {};
		throw err;
	}
}


async function main() {
	const config = await loadConfig();
	const example = await readFile("./exampleContract.js");
	const extrinsic = "remove_stake";

  const prompt = `
		You are the senior protocol engineer well familiar with blockchain, Rust, Substrate, 
		and JavaScript. Attached is the Subtensor code base. It is a substrate based blockchain.
		Write the test based on the example below for testing extrinsic ${extrinsic}. This test 
		will be placed in a single file and executed later. You should replace the following 
		fields in the ExampleContract in this test:

		- Class name: Should reflect extrinsic being tested: ${extrinsic}
		- parameterCount: Should reflect number of parameters required for ${extrinsic} excluding 
		  the origin
		- getParameterDesc: Should return the description of the parameter identified by its index,
		  which includes possible values for this parameter either as a list or as a range. All in
			human-readable format, but if parameters are provided as a list, the concrete values from 
			this list can be used.
		- precondition: Should gather values of all state maps that are updated when 
		  ${extrinsic} is executed
		- action: Should execute the extrinsic ${extrinsic} with provided parameters
		- postcondition: Should gather the values of all state maps that should have been updated during 
      the execution and verifies that update was correct

		You may use readFreeBalance and sendTransaction helper functions from my utils.js, but if you need
		to read any other state maps, implement your own functions.

		Only output JavaScript code.

		Example:

		${example}
		`.trim();

  const res = await client.responses.create({
    model: "gpt-5",
    input: prompt,
    tools: [
      { type: "file_search", vector_store_ids: [config.vs] }
    ],
  });

  console.log(res.output_text);
  console.log(`Usage: ${res.usage.total_tokens}`);
}

main().catch(err => {
  console.error(err?.response?.data ?? err);
  process.exit(1);
});
