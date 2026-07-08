import { Router, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertUserSchema } from "@shared/schema";
import { requirePageWrite } from "../lib/pageAccess";

const router = Router();

// List users
router.get("/users", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const users = await storage.listUsers(limit, offset);

    const usersWithoutPins = users.map((user) => {
      const { pin, ...userWithoutPin } = user;
      return userWithoutPin;
    });

    res.json(usersWithoutPins);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// Get single user
router.get("/users/:userCode", async (req: Request, res: Response) => {
  const user = await storage.getUser(req.params.userCode);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }
  const { pin, ...userWithoutPin } = user;
  res.json(userWithoutPin);
});

// Create user
router.post("/users", requirePageWrite("user-management"), async (req: Request, res: Response) => {
  try {
    const userData = insertUserSchema.parse(req.body);

    console.log("Creating user with data:", {
      ...userData,
      pin: userData.pin ? "[REDACTED]" : undefined,
    });

    const user = await storage.createUser(userData);
    const { pin, ...userWithoutPin } = user;
    console.log("User created successfully:", userWithoutPin);

    res.status(201).json(userWithoutPin);
  } catch (err) {
    console.error("Error creating user:", err);

    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: "Invalid user data",
        errors: err.format(),
      });
    }

    if (
      err instanceof Error &&
      err.message.includes("PIN") &&
      err.message.includes("already used")
    ) {
      return res.status(400).json({
        message: err.message,
        type: "pin_duplicate_error",
      });
    }

    res.status(500).json({
      message: "Failed to create user",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Update user
router.put("/users/:userCode", requirePageWrite("user-management"), async (req: Request, res: Response) => {
  try {
    const userCode = req.params.userCode;
    const user = await storage.getUser(userCode);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = insertUserSchema.partial().parse(req.body);
    const updatedUser = await storage.updateUser(userCode, userData);

    if (!updatedUser) {
      return res.status(404).json({ message: "User could not be updated" });
    }

    const { pin, ...userWithoutPin } = updatedUser;
    res.json(userWithoutPin);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: "Invalid user data",
        errors: err.format(),
      });
    }

    if (
      err instanceof Error &&
      err.message.includes("PIN") &&
      err.message.includes("already used")
    ) {
      return res.status(400).json({
        message: err.message,
        type: "pin_duplicate_error",
      });
    }

    console.error("Failed to update user:", err);
    res.status(500).json({
      message: "Failed to update user",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Delete user
router.delete("/users/:userCode", requirePageWrite("user-management"), async (req: Request, res: Response) => {
  try {
    const userCode = req.params.userCode;
    const user = await storage.getUser(userCode);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const success = await storage.deleteUser(userCode);

    if (!success) {
      return res.status(500).json({ message: "Failed to delete user" });
    }

    res.status(204).send();
  } catch (err) {
    console.error("Failed to delete user:", err);
    res.status(500).json({ message: "Failed to delete user" });
  }
});

// Upload profile image
router.patch(
  "/users/:userCode/profile-image",
  async (req: Request, res: Response) => {
    try {
      const userCode = req.params.userCode;
      const user = await storage.getUser(userCode);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const profileImageSchema = z.object({
        imageBase64: z
          .string()
          .startsWith("data:image/", {
            message: "Image must be in base64 format starting with 'data:image/'",
          })
          .max(750000, {
            message: "Image size too large. Maximum 750KB allowed.",
          })
          .refine(
            (data) => {
              const validFormats = [
                "data:image/jpeg",
                "data:image/jpg",
                "data:image/png",
                "data:image/gif",
                "data:image/webp",
              ];
              return validFormats.some((format) =>
                data.toLowerCase().startsWith(format),
              );
            },
            {
              message:
                "Unsupported image format. Only JPEG, PNG, GIF, and WebP are allowed.",
            },
          ),
      });

      const { imageBase64 } = profileImageSchema.parse(req.body);

      const updatedUser = await storage.updateUser(userCode, {
        profileImage: imageBase64,
      });

      if (!updatedUser) {
        return res.status(404).json({ message: "User could not be updated" });
      }

      const { pin, ...userWithoutPin } = updatedUser;
      res.json(userWithoutPin);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid image data",
          errors: err.format(),
        });
      }

      console.error("Failed to update user profile image:", err);
      res.status(500).json({
        message: "Failed to update profile image",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// Serve profile image
router.get(
  "/users/:userCode/profile-image",
  async (req: Request, res: Response) => {
    try {
      const userCode = req.params.userCode;
      console.log(`[DEBUG] Profile image request for user: ${userCode}`);

      const user = await storage.getUser(userCode);

      if (!user) {
        console.log(`[DEBUG] User ${userCode} not found`);
        return res.status(404).json({ message: "User not found" });
      }

      if (!user.profileImage) {
        console.log(`[DEBUG] No profile image for user ${userCode}`);
        return res.status(404).json({ message: "Profile image not found" });
      }

      console.log(
        `[DEBUG] Found profile image for user ${userCode}, data length: ${user.profileImage.length}`,
      );

      const matches = user.profileImage.match(/^data:(.+);base64,(.+)$/);

      if (!matches) {
        console.log(`[DEBUG] Invalid image format for user ${userCode}`);
        return res.status(400).json({ message: "Invalid image format" });
      }

      const [, contentType, base64Data] = matches;
      console.log(
        `[DEBUG] Serving image for user ${userCode} with content-type: ${contentType}`,
      );

      const imageBuffer = Buffer.from(base64Data, "base64");

      res.set({
        "Content-Type": contentType,
        "Content-Length": imageBuffer.length.toString(),
        "Cache-Control": "public, max-age=3600",
      });

      res.end(imageBuffer);
    } catch (err) {
      console.error(
        `[ERROR] Failed to serve profile image for user ${req.params.userCode}:`,
        err,
      );
      res.status(500).json({
        message: "Failed to serve profile image",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// Login endpoint (PIN-only authentication)
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ message: "PIN is required" });
    }

    const allUsers = await storage.listUsers(1000, 0);
    const user = allUsers.find((user) => user.pin === pin);

    if (!user) {
      return res.status(401).json({ message: "Invalid PIN" });
    }

    const { pin: _, ...userWithoutPin } = user;

    res.json({
      user: userWithoutPin,
      message: "Login successful",
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "An error occurred during login" });
  }
});

export default router;
